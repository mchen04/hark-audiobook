#!/usr/bin/env python3
"""Build weightless ONNX graphs for Kestrel's student-fast browser runtime.

The generated graphs reference the published safetensors files in place. Their
raw tensor offsets are valid ONNX external-data offsets, so Hark can fetch and
cache the original Kestrel weights instead of checking in a second 40 MB copy.

Usage:
  uv run --with onnx scripts/export-kestrel-onnx.py \
    --kestrel-root /path/to/kestrel-tts \
    --output-dir public/models/kestrel
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import struct
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


OPSET = 17


@dataclass(frozen=True)
class ExternalTensor:
    shape: tuple[int, ...]
    dtype: int
    offset: int
    length: int


class SafetensorsIndex:
    def __init__(self, path: Path, location: str):
        self.path = path
        self.location = location
        with path.open("rb") as source:
            header_length = struct.unpack("<Q", source.read(8))[0]
            header = json.loads(source.read(header_length))
        data_start = 8 + header_length
        self.tensors: dict[str, ExternalTensor] = {}
        for name, value in header.items():
            if name == "__metadata__":
                continue
            if value["dtype"] != "F32":
                raise ValueError(f"{path}: unsupported dtype {value['dtype']} for {name}")
            start, end = value["data_offsets"]
            self.tensors[name] = ExternalTensor(
                shape=tuple(value["shape"]),
                dtype=TensorProto.FLOAT,
                offset=data_start + start,
                length=end - start,
            )


class GraphBuilder:
    def __init__(self, sources: dict[str, SafetensorsIndex]):
        self.sources = sources
        self.nodes: list[onnx.NodeProto] = []
        self.initializers: list[onnx.TensorProto] = []
        self._names: set[str] = set()
        self._counter = 0

    def name(self, stem: str) -> str:
        self._counter += 1
        return f"{stem}_{self._counter}"

    def node(
        self,
        op_type: str,
        inputs: Sequence[str],
        stem: str,
        *,
        outputs: int = 1,
        **attributes: object,
    ) -> str | tuple[str, ...]:
        names = tuple(self.name(stem) for _ in range(outputs))
        self.nodes.append(helper.make_node(op_type, list(inputs), list(names), **attributes))
        return names[0] if outputs == 1 else names

    def constant(self, value: float | int | Sequence[int], stem: str) -> str:
        name = self.name(stem)
        if isinstance(value, float):
            array = np.asarray(value, dtype=np.float32)
        elif isinstance(value, int):
            array = np.asarray(value, dtype=np.int64)
        else:
            array = np.asarray(value, dtype=np.int64)
        self.initializers.append(numpy_helper.from_array(array, name=name))
        return name

    def tensor(self, source_name: str, key: str) -> str:
        name = f"{source_name}__{key.replace('.', '_')}"
        if name in self._names:
            return name
        source = self.sources[source_name]
        tensor = source.tensors[key]
        initializer = TensorProto(name=name, data_type=tensor.dtype, dims=tensor.shape)
        initializer.data_location = TensorProto.EXTERNAL
        initializer.external_data.add(key="location", value=source.location)
        initializer.external_data.add(key="offset", value=str(tensor.offset))
        initializer.external_data.add(key="length", value=str(tensor.length))
        self.initializers.append(initializer)
        self._names.add(name)
        return name

    def identity(self, value: str, output: str) -> None:
        self.nodes.append(helper.make_node("Identity", [value], [output]))

    def unsqueeze(self, value: str, axes: Sequence[int], stem: str) -> str:
        return self.node("Unsqueeze", [value, self.constant(axes, f"{stem}_axes")], stem)  # type: ignore[return-value]

    def squeeze(self, value: str, axes: Sequence[int], stem: str) -> str:
        return self.node("Squeeze", [value, self.constant(axes, f"{stem}_axes")], stem)  # type: ignore[return-value]

    def linear(self, value: str, source: str, prefix: str, stem: str) -> str:
        weight = self.tensor(source, f"{prefix}.weight")
        transposed = self.node("Transpose", [weight], f"{stem}_weight", perm=[1, 0])
        result = self.node("MatMul", [value, transposed], f"{stem}_matmul")
        bias_key = f"{prefix}.bias"
        if bias_key in self.sources[source].tensors:
            result = self.node("Add", [result, self.tensor(source, bias_key)], f"{stem}_bias")
        return result  # type: ignore[return-value]

    def layer_norm(self, value: str, stem: str) -> str:
        mean = self.node("ReduceMean", [value], f"{stem}_mean", axes=[-1], keepdims=1)
        centered = self.node("Sub", [value, mean], f"{stem}_center")
        squared = self.node("Mul", [centered, centered], f"{stem}_square")
        variance = self.node("ReduceMean", [squared], f"{stem}_variance", axes=[-1], keepdims=1)
        denominator = self.node(
            "Sqrt",
            [self.node("Add", [variance, self.constant(1e-5, f"{stem}_epsilon")], f"{stem}_stable")],
            f"{stem}_sqrt",
        )
        return self.node("Div", [centered, denominator], f"{stem}_normalized")  # type: ignore[return-value]

    def gelu(self, value: str, stem: str) -> str:
        scaled = self.node(
            "Div", [value, self.constant(math.sqrt(2), f"{stem}_sqrt2")], f"{stem}_scaled"
        )
        erf = self.node("Erf", [scaled], f"{stem}_erf")
        shifted = self.node("Add", [erf, self.constant(1.0, f"{stem}_one")], f"{stem}_shift")
        gated = self.node("Mul", [value, shifted], f"{stem}_gate")
        return self.node("Mul", [gated, self.constant(0.5, f"{stem}_half")], stem)  # type: ignore[return-value]

    def adaln(
        self,
        value: str,
        style: str,
        source: str,
        prefix: str,
        dim: int,
        stem: str,
    ) -> str:
        scale_shift = self.linear(style, source, f"{prefix}.fc", f"{stem}_style")
        split_sizes = self.constant([dim, dim], f"{stem}_split_sizes")
        scale, shift = self.node(
            "Split", [scale_shift, split_sizes], f"{stem}_split", outputs=2, axis=-1
        )
        scale = self.unsqueeze(scale, [1], f"{stem}_scale")
        shift = self.unsqueeze(shift, [1], f"{stem}_shift")
        normalized = self.layer_norm(value, f"{stem}_norm")
        scale = self.node("Add", [scale, self.constant(1.0, f"{stem}_one")], f"{stem}_gain")
        return self.node(
            "Add", [self.node("Mul", [normalized, scale], f"{stem}_scaled"), shift], stem
        )  # type: ignore[return-value]

    def depthwise_conv(
        self, value: str, source: str, prefix: str, dim: int, kernel: int, stem: str
    ) -> str:
        channels_first = self.node("Transpose", [value], f"{stem}_input", perm=[0, 2, 1])
        raw_weight = self.tensor(source, f"{prefix}.weight")
        weight = self.node("Transpose", [raw_weight], f"{stem}_weight", perm=[0, 2, 1])
        convolved = self.node(
            "Conv",
            [channels_first, weight, self.tensor(source, f"{prefix}.bias")],
            f"{stem}_conv",
            group=dim,
            kernel_shape=[kernel],
            pads=[kernel // 2, kernel // 2],
            strides=[1],
        )
        return self.node("Transpose", [convolved], stem, perm=[0, 2, 1])  # type: ignore[return-value]

    def convnext_block(
        self,
        value: str,
        style: str,
        source: str,
        prefix: str,
        dim: int,
        *,
        cn_style: bool,
    ) -> str:
        residual = value
        value = self.depthwise_conv(value, source, f"{prefix}.dw", dim, 7, f"{prefix}_dw")
        norm_prefix = prefix if cn_style else f"{prefix}.norm"
        value = self.adaln(value, style, source, norm_prefix, dim, f"{prefix}_adaln")
        value = self.linear(value, source, f"{prefix}.pw1", f"{prefix}_pw1")
        value = self.gelu(value, f"{prefix}_gelu")
        value = self.linear(value, source, f"{prefix}.pw2", f"{prefix}_pw2")
        return self.node("Add", [residual, value], f"{prefix}_residual")  # type: ignore[return-value]

    def gather_sequence(self, value: str, indices: str, stem: str) -> str:
        gathered = self.node("Gather", [value, indices], f"{stem}_gather", axis=1)
        return self.squeeze(gathered, [1], stem)

    def clip(self, value: str, minimum: float, maximum: float, stem: str) -> str:
        return self.node(
            "Clip",
            [
                value,
                self.constant(minimum, f"{stem}_minimum"),
                self.constant(maximum, f"{stem}_maximum"),
            ],
            stem,
        )  # type: ignore[return-value]


def value_info(name: str, dtype: int, shape: Sequence[int | str]) -> onnx.ValueInfoProto:
    return helper.make_tensor_value_info(name, dtype, list(shape))


def save_graph(
    builder: GraphBuilder,
    path: Path,
    name: str,
    inputs: Iterable[onnx.ValueInfoProto],
    outputs: Iterable[onnx.ValueInfoProto],
) -> None:
    graph = helper.make_graph(
        builder.nodes,
        name,
        list(inputs),
        list(outputs),
        initializer=builder.initializers,
    )
    model = helper.make_model(
        graph,
        producer_name="Hark Kestrel exporter",
        opset_imports=[helper.make_opsetid("", OPSET)],
    )
    model.ir_version = 9
    model.metadata_props.add(key="kestrel_preset", value="student-fast")
    model.metadata_props.add(key="kestrel_license", value="Apache-2.0")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        check_dir = Path(directory)
        check_model = check_dir / path.name
        for source in builder.sources.values():
            shutil.copyfile(source.path, check_dir / source.location)
        onnx.save_model(model, check_model)
        onnx.checker.check_model(check_model, full_check=False)
    onnx.save_model(model, path)


def build_prosody_encode(source: SafetensorsIndex, output: Path) -> None:
    builder = GraphBuilder({"prosody": source})
    encoded = builder.node(
        "Gather", [builder.tensor("prosody", "emb.weight"), "input_ids"], "embedding", axis=0
    )
    for index in range(6):
        encoded = builder.convnext_block(
            encoded,
            "style",
            "prosody",
            f"blocks.{index}",
            256,
            cn_style=True,
        )
    text_features = builder.linear(encoded, "prosody", "ten_head", "text_features")
    durations = builder.linear(encoded, "prosody", "dur_head", "duration_logits")
    durations = builder.node("Softplus", [durations], "duration_softplus")
    durations = builder.squeeze(durations, [-1], "durations")
    builder.identity(encoded, "encoded")
    builder.identity(text_features, "text_features")
    builder.identity(durations, "durations")
    save_graph(
        builder,
        output,
        "kestrel_prosody_encode",
        [
            value_info("input_ids", TensorProto.INT64, [1, 512]),
            value_info("style", TensorProto.FLOAT, [1, 256]),
        ],
        [
            value_info("encoded", TensorProto.FLOAT, [1, 512, 256]),
            value_info("text_features", TensorProto.FLOAT, [1, 512, 512]),
            value_info("durations", TensorProto.FLOAT, [1, 512]),
        ],
    )


def build_prosody_frames(source: SafetensorsIndex, output: Path) -> None:
    builder = GraphBuilder({"prosody": source})
    frames = builder.gather_sequence("encoded", "frame_phoneme_indices", "frame_features")
    position = builder.unsqueeze("phoneme_positions", [-1], "phoneme_positions")
    log_duration = builder.unsqueeze("log_durations", [-1], "log_durations")
    frames = builder.node("Concat", [frames, position, log_duration], "frame_conditioning", axis=-1)
    frames = builder.linear(frames, "prosody", "fproj", "frame_projection")
    for index in range(4):
        frames = builder.convnext_block(
            frames,
            "style",
            "prosody",
            f"fblocks.{index}",
            192,
            cn_style=True,
        )
    f0 = builder.linear(frames, "prosody", "f0_head", "f0_normalized")
    f0 = builder.squeeze(f0, [-1], "f0_squeezed")
    f0 = builder.node("Mul", [f0, builder.constant(100.0, "f0_scale")], "f0")
    energy = builder.linear(frames, "prosody", "n_head", "energy_projected")
    energy = builder.squeeze(energy, [-1], "energy")
    text = builder.gather_sequence("encoded", "text_phoneme_indices", "text_frames")
    text = builder.linear(text, "prosody", "ten_head", "asr")
    builder.identity(f0, "f0")
    builder.identity(energy, "energy")
    builder.identity(text, "text_features")
    save_graph(
        builder,
        output,
        "kestrel_prosody_frames",
        [
            value_info("encoded", TensorProto.FLOAT, [1, 512, 256]),
            value_info("style", TensorProto.FLOAT, [1, 256]),
            value_info("frame_phoneme_indices", TensorProto.INT64, [1, "frames_80"]),
            value_info("text_phoneme_indices", TensorProto.INT64, [1, "frames_40"]),
            value_info("phoneme_positions", TensorProto.FLOAT, [1, "frames_80"]),
            value_info("log_durations", TensorProto.FLOAT, [1, "frames_80"]),
        ],
        [
            value_info("f0", TensorProto.FLOAT, [1, "frames_80"]),
            value_info("energy", TensorProto.FLOAT, [1, "frames_80"]),
            value_info("text_features", TensorProto.FLOAT, [1, "frames_40", 512]),
        ],
    )


def build_decoder_head(
    decoder_source: SafetensorsIndex, head_source: SafetensorsIndex, output: Path
) -> None:
    builder = GraphBuilder({"decoder": decoder_source, "head": head_source})
    repeated = builder.unsqueeze("text_features", [2], "repeat_text")
    repeated = builder.node(
        "Tile", [repeated, builder.constant([1, 1, 2, 1], "repeat_text_shape")], "tiled_text"
    )
    repeated = builder.node(
        "Reshape", [repeated, builder.constant([1, -1, 512], "repeated_text_shape")], "repeated_text"
    )
    f0_column = builder.unsqueeze("f0", [-1], "f0_column")
    safe_f0 = builder.node(
        "Max", [f0_column, builder.constant(1.0, "minimum_f0")], "safe_f0"
    )
    log_f0 = builder.node("Log", [safe_f0], "log_f0")
    log_f0 = builder.node(
        "Div", [log_f0, builder.constant(6.0, "log_f0_scale")], "scaled_log_f0"
    )
    voiced = builder.node(
        "Greater", [f0_column, builder.constant(10.0, "voiced_threshold")], "voiced_bool"
    )
    voiced = builder.node("Cast", [voiced], "voiced", to=TensorProto.FLOAT)
    energy_column = builder.unsqueeze("energy", [-1], "energy_column")
    decoded = builder.node(
        "Concat", [repeated, log_f0, voiced, energy_column], "decoder_conditioning", axis=-1
    )
    decoded = builder.linear(decoded, "decoder", "inp", "decoder_input")
    for index in range(6):
        decoded = builder.convnext_block(
            decoded,
            "style",
            "decoder",
            f"blocks.{index}",
            256,
            cn_style=False,
        )
    decoded = builder.adaln(decoded, "style", "decoder", "norm", 256, "decoder_norm")
    decoded = builder.linear(decoded, "decoder", "out", "decoded")

    zero = builder.node("Mul", [voiced, builder.constant(0.0, "zero")], "zero_frames")
    ones = builder.node("Add", [zero, builder.constant(1.0, "one")], "one_frames")
    head_input = builder.node(
        "Concat", [decoded, voiced, log_f0, energy_column, ones], "head_conditioning", axis=-1
    )
    head = builder.linear(head_input, "head", "inp", "head_input")
    for index in range(6):
        head = builder.convnext_block(
            head,
            "style",
            "head",
            f"blocks.{index}",
            192,
            cn_style=False,
        )
    head = builder.adaln(head, "style", "head", "norm", 192, "head_norm")
    magnitude = builder.linear(head, "head", "filt_mag", "filter_log_magnitude")
    magnitude = builder.node(
        "Exp", [builder.clip(magnitude, -12.0, 8.0, "bounded_filter_magnitude")], "filter_magnitude"
    )
    phase = builder.linear(head, "head", "filt_phs", "filter_phase")
    noise = builder.linear(head, "head", "nz_head", "noise_log_envelope")
    noise = builder.node(
        "Exp", [builder.clip(noise, -14.0, 6.0, "bounded_noise_envelope")], "noise_envelope"
    )
    builder.identity(magnitude, "filter_magnitude")
    builder.identity(phase, "filter_phase")
    builder.identity(noise, "noise_envelope")
    save_graph(
        builder,
        output,
        "kestrel_decoder_head",
        [
            value_info("text_features", TensorProto.FLOAT, [1, "frames_40", 512]),
            value_info("f0", TensorProto.FLOAT, [1, "frames_80"]),
            value_info("energy", TensorProto.FLOAT, [1, "frames_80"]),
            value_info("style", TensorProto.FLOAT, [1, 128]),
        ],
        [
            value_info("filter_magnitude", TensorProto.FLOAT, [1, "frames_80", 601]),
            value_info("filter_phase", TensorProto.FLOAT, [1, "frames_80", 601]),
            value_info("noise_envelope", TensorProto.FLOAT, [1, "frames_80", 601]),
        ],
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kestrel-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    weights = args.kestrel_root / "weights"
    prosody = SafetensorsIndex(weights / "kestrel_prosody.safetensors", "prosody.safetensors")
    decoder = SafetensorsIndex(weights / "kestrel_decode.safetensors", "decoder.safetensors")
    head = SafetensorsIndex(
        weights / "kestrel_sf_lw58k" / "gen.safetensors", "head.safetensors"
    )
    build_prosody_encode(prosody, args.output_dir / "prosody-encode.onnx")
    build_prosody_frames(prosody, args.output_dir / "prosody-frames.onnx")
    build_decoder_head(decoder, head, args.output_dir / "decoder-head.onnx")


if __name__ == "__main__":
    main()

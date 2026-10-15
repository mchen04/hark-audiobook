import { expect, it } from "vitest";

import { resumeControl, servedBuildId } from "./resume-control";

it("fails a stalled control call with its diagnostic", async () => {
  await expect(
    resumeControl(new Promise<never>(() => {}), () => ({ operation: "newPage", pages: 8 }), 10),
  ).rejects.toThrow('Resume control stalled after 10ms: {"operation":"newPage","pages":8}');
});

it("returns a completed control call", async () => {
  expect(await resumeControl(Promise.resolve(42), () => "unused")).toBe(42);
});

it("keeps the original control error", async () => {
  const error = new Error("page crashed");
  await expect(resumeControl(Promise.reject(error), () => "unused")).rejects.toBe(error);
});

it.each(["candidate-build", "frozen-base"])("reads the served %s ID", (id) => {
  expect(servedBuildId(`<script>self.__next_f.push([1,"0:{\\"b\\":\\"${id}\\"}"])</script>`)).toBe(
    id,
  );
});

it("rejects a document that cannot prove its build", () => {
  expect(() => servedBuildId("<title>Unavailable</title>")).toThrow("no build ID");
});

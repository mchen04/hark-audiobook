#!/usr/bin/python3
import ctypes
import os
import sys

libc = ctypes.CDLL(None)
attributes = ctypes.c_void_p()
for name, arguments in [
    ('posix_spawnattr_init', [ctypes.byref(attributes)]),
    ('posix_spawnattr_setflags', [ctypes.byref(attributes), 0x0040]),
    ('responsibility_spawnattrs_setdisclaim', [ctypes.byref(attributes), 1]),
]:
    error = getattr(libc, name)(*arguments)
    if error:
        raise OSError(error, name)
executable = os.environ.pop('HARK_BROWSER_EXECUTABLE')
arguments = [executable, *sys.argv[1:]]
environment = [f'{key}={value}' for key, value in os.environ.items()]
vector = lambda values: (ctypes.c_char_p * (len(values) + 1))(*[os.fsencode(value) for value in values], None)
error = libc.posix_spawn(None, os.fsencode(executable), None, ctypes.byref(attributes), vector(arguments), vector(environment))
raise OSError(error, 'Browser exec failed')

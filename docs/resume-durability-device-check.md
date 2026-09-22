# Physical-device resume check

The unanswered device-specific question is whether an installed iOS PWA keeps
both its periodic progress writer and audio `timeupdate` writer alive while the
screen is off. Desktop automation can test suspended-writer recovery, but cannot
establish that actual iOS scheduling behavior.

The player persists progress on a 200 ms cadence while playing, on media events,
and at lifecycle boundaries. If neither writer runs while audio continues, the
last durable position can lag what was heard. Recovery starts at the saved
position and can **offer** a labelled estimate; it does not silently seek forward.
An estimate is not evidence that audio played continuously during suspension.

## Before starting

Use a physical iPhone, an installed Home Screen PWA, a disposable account, and a
locally saved book longer than the test. Record device/iOS, served build, battery
mode, playback speed, and network state. Disable the sleep timer for this check.
Keep a second clock and record what you actually hear. Allow at least seven
minutes per attempt, plus a repeat offline.

## Procedure

1. Open the book and play for about 30 seconds. Record its position, speed, and
   wall-clock time immediately before locking the screen.
2. Leave it locked and playing for five minutes. Note any audible interruption,
   pause, or end; elapsed wall time alone is not a playback measurement.
3. Unlock and terminate the app promptly through the app switcher, without first
   opening the player or pressing pause. Record the unlock/termination times.
   Unlocking can wake the page and flush a new position: disclose this confound
   rather than claiming a perfectly background-only observation.
4. Relaunch without starting playback. Open **Settings → Resume diagnostics** and
   record the saved position, writer, and age before another session replaces it.
5. Open the book without autoplay. Compare its initial position with the saved
   position and the independently observed listening interval. Record any
   recovery offer; check both dismissing it and explicitly accepting its estimate
   in separate attempts. Neither action should happen automatically.
6. Repeat with networking disabled after the book/shell are cached, and record
   results separately. Reconnect afterward to inspect sync if needed.

## Interpreting the result

| Observation                                                         | What it supports                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A cadence/media writer near termination with a matching position    | At least one writer persisted late in this attempt; unlocking may have contributed.    |
| An old visibility/lifecycle write near the lock edge                | No later durable write is visible; compare with heard audio to quantify lost progress. |
| A recovered position ahead of the durable record before user action | A failure to investigate, not expected estimation behavior.                            |
| A labelled recovery estimate                                        | The gap detector triggered; it does not prove uninterrupted screen-off audio.          |

Report the raw times, saved and observed positions, writer names, any seek/rewind,
and interruptions. A single late write does not prove both callbacks stayed alive
throughout the locked interval. Run separate attempts when diagnosing scheduling.

## Automated coverage

`pnpm test:resume:ci` exercises the production resume oracle while explicitly
excluding `T1 hidden online` and `T1 hidden offline`. `pnpm test:resume` retains
those assertions and may fail with `UNCOVERED` if the engine cannot produce a
truly hidden page. The
[suspension recovery spec](../tests/resume/suspension-recovery.spec.ts) exercises
recovery from constructed durable records, not physical iOS scheduling.
Historical benchmark results apply only to their original commits/runtimes;
this procedure makes no new device pass claim.

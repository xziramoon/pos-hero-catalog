# Real photo fixtures (optional)

Drop the shop owner's photos here (`.jpg`, `.jpeg` or `.png`). `test/pipeline.test.js`
picks up every image in this folder automatically, runs the final pipeline on it and
prints its quality/reasons in the per-fixture table.

If the file name (without extension) is one of the names below, the expected quality
from spec section 13 is asserted; any other name is only run and listed.

| file                 | case                                   | expected      |
|----------------------|----------------------------------------|---------------|
| `web-white.jpg`      | web photo, white bg, small product     | ok            |
| `phone-tilted.jpg`   | phone, on a table, tilted              | ok            |
| `counter-landscape.jpg` | wooden counter, landscape           | ok            |
| `dark.jpg`           | dark room                              | check or ok   |
| `sideways.jpg`       | rotated 90 deg, no EXIF                | check         |
| `closeup-label.jpg`  | close-up, label only                   | ok            |
| `tall-tight.jpg`     | tight tall crop                        | ok            |
| `far-small.jpg`      | far away, small product                | retake/check  |

Notes
- The test decoder (jpeg-js) ignores EXIF orientation. Photos straight from a phone may
  therefore appear rotated in tests; re-save them upright (or accept that `sideways`
  style failures are expected). The real worker applies EXIF via `createImageBitmap`.
- Eyeball a photo: `node renderer/catalog/image/tools/run-on-file.js test/fixtures/photos/x.jpg test/fixtures/out/`
- Do not commit private customer photos unless the owner agrees (this folder is tracked).

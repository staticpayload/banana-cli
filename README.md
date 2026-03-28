# banana-cli

`banana-cli` is a Node.js command-line tool for Gemini image generation and reference-image editing.

## Requirements

- Node.js 20+
- `GEMINI_API_KEY` or `GOOGLE_API_KEY`

## Install

```bash
npm install
```

## Usage

```bash
banana "text prompt"
banana --media /path/to/image.jpg "edit this"
banana --media /path/to/image.jpg --model nano-banana-2 --count 2 --out out.png --json response.json
banana --media /path/to/image.jpg --out ./renders/
cat prompt.txt | banana --prompt -
```

## Behavior

- Default model: `nano-banana-pro`
- Model aliases map to the Gemini preview image models used by the existing nano-banana workflow
- `--media` is repeatable, but only the first resolved media source is sent to Gemini
- If no prompt is provided and media is available, the CLI uses `Create a derivative image based on the attached media.`
- If no prompt and no media input are available, the CLI exits with a clear usage error
- The CLI inspects prompt `MEDIA:` lines, environment variables such as `MEDIA_PATH`, and `OPENCLAW_CONTEXT` JSON for fallback media sources
- If `--out` points at a directory, generated files are written into that directory with prompt-derived filenames
- Successful runs print only `MEDIA:<path>` lines on stdout
- Human-readable diagnostics stay on stderr, and `--quiet` suppresses non-essential stderr output

## Options

- `--prompt <text>`: explicit prompt text. Use `-` to read the prompt from stdin.
- `--stdin`: read the prompt from stdin when no prompt argument is present.
- `--media <path-or-url>`: repeatable reference image source.
- `--model <alias-or-id>`: model alias or direct Gemini model id.
- `--count <1..4>`: number of images to request.
- `--out <path>`: output file path or directory. Multiple images append `_1`, `_2`, and so on.
- `--json <path>`: save the raw API response to disk.
- `--verbose`: print resolved model/media details to stderr.
- `--quiet`: suppress non-essential stderr output.

## Notes

- Output filenames are sanitized from the prompt and made unique when needed.
- Generated image bytes are decoded, MIME-checked, written to disk, and verified before the CLI prints the `MEDIA:` lines.

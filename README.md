# banana-cli

`banana` is a CLI wrapper around Gemini image generation endpoints.

It implements the same behavior as the internal `nano-banana` skill:

- Text prompt generation
- Optional reference image (`--media`) for image editing
- Model alias support (`nano-banana-2`, `nano-banana-pro`, etc.)
- `--count` up to 4 images
- Optional output path (`--out`)
- Optional API response dump (`--json`)
- `MEDIA:<path>` output so downstream tools can attach generated images directly

## Setup

```bash
npm install
npm link
```

Set one of these env vars:

```bash
export GEMINI_API_KEY=...
# or
export GOOGLE_API_KEY=...
```

## Usage

```bash
# simple prompt
banana "a cyberpunk racetrack scene"

# edit with reference image
banana --media ./input.jpg "change this driver's suit to black merc f1 suit"

# explicit model + count + explicit output + JSON dump
banana --media ./input.jpg --model nano-banana-2 --count 2 --out ./output.png --json ./response.json "make this image cinematic"

# explicit --prompt
banana --prompt "a brutalist banana logo on cream"

# read prompt from stdin when no positional prompt is provided
cat prompt.txt | banana
```

## Options

- `--prompt, -p` Prompt text (or `-` to read stdin)
- `--media, -m` Reference image path/URL (repeatable; first one is used for generation)
- `--model` Model alias/name (default: `nano-banana-pro`)
- `--count` Number of images (1-4)
- `--out` Output path override
- `--json` Save raw response to path
- `--verbose, -v` Print request/debug details to stderr

## Output contract

Generated results are printed as plain lines. When images are returned, only generated attachments use `MEDIA:` lines:

```text
MEDIA:/absolute/path/to/file.png
```

No filesystem path chatter is printed unless you request `--verbose`.

# Whistle dictation

Local voice dictation for Pi using [Cactus Whistle](https://cactuscompute.com/blog/whistle).

## Setup

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and make sure it is on `PATH`. On first use, the extension runs `uv` against its `pyproject.toml` and `uv.lock`, creating a local environment and installing Cactus Needle's microphone dependencies. To install them ahead of time from this repository:

```sh
uv sync --project extensions/whistle-dictate
```

Set `WHISTLE_UV` if the executable is not named `uv` or is not on `PATH`. The first dictation also loads the Whistle model into Cactus's local cache. The model is about 17 MB; audio is processed on-device and is not sent to a speech service.

## Use

- Press **Alt+M** to start recording; press it again to stop and insert the transcript.
- Press **Alt+N** to cancel and discard the recording.
- Run **`/whistle`** to toggle dictation, or **`/whistle cancel`** to discard it.

The extension appends committed transcript text to whichever Pi input is focused when recording stops. For opaque dialogs, it sends text as keystrokes; move focus into the desired text field first. If no focused component can accept input, it tries to copy the transcript to the system clipboard.

While recording, the status bar shows a microphone-level meter. Dictation stays local; the extension runs the Cactus Python API in a helper process, captures the default microphone, and resamples audio to Whistle's 16 kHz mono input. It inserts Whistle's committed `text` and does not force the provisional `pending` tail into the prompt; the final stream result is still collected on stop. Microphone permissions and available devices depend on your OS and audio stack.

Whistle documents English, German, French, Spanish, Italian, Dutch, and Polish. See the [Cactus Whistle page](https://cactuscompute.com/blog/whistle) for model details.

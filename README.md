# Stratum

**Can Gemini make the physical world safer?**

Live app: https://stratum-147783037481.asia-northeast3.run.app · Demo video: https://www.youtube.com/watch?v=9-cJ6LuP8J4

In January 2025 a power bank was blamed for a fire that destroyed a passenger jet in Busan ([1], [2]). Small hardware teams rarely have a teardown lab or a simulation team to catch risks like this before a product ships.

## How it works

1. Paste a product link. Gemini, with Google Search, reads the product page, teardowns and photos and rebuilds the device as a list of parts.
2. Every value is labelled by where it came from: observed, documented, inferred, assumed or unknown.
3. Stratum builds a first 3D model, sketches how the parts affect each other, and proposes a safety goal.
4. Nothing changes until the engineer confirms the goal.
5. Each redesign step states its prediction first; a thermal simulator checks it afterwards.
6. The result exports to MATLAB/Simulink for an independent check.

The orchestrator can be Gemini 4 Argon or Gemini 3.8 Flash, so the same product can be compared across models.

| Orchestrator | Time to parts list | Sources | Images read |
|---|---|---|---|
| Gemini 4 Argon | 212 s | 68 | 9 |
| Gemini 3.8 Flash | 126 s | 10 | 9 |

## Next

Today this is one guided round. The next step is a closed loop where test results flow back in and the next design starts from what was missed, with a person approving every step.

The answers are only as good as public information, and unknowns stay unknown. We don't know what engineering will look like when models become far more capable. We want to keep the record from the start, and this is the first milestone, built with Gemini 4.

## Run locally

```bash
pip install -r api/requirements.txt -r cad/requirements.txt -r bridge/requirements.txt
npm --prefix web ci && npm --prefix web run build
uvicorn stratum_api.app:create_app --factory --port 8080
```

Built on Cloud Run, Firestore, Cloud Storage, build123d and three.js. Inspired by [morluto/rea](https://github.com/morluto/rea). MIT license.

[1] https://en.wikipedia.org/wiki/Air_Busan_Flight_391
[2] https://www.koreajoongangdaily.com/korea/transport-ministry-points-to-charger-short-circuit-as-likely-cause-of-air-busan-fire/11944784

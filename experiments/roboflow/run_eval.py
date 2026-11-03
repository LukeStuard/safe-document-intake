"""Scores the Roboflow-trained document classifier on its held-out test split.

A standalone experiment: it touches nothing in the Worker, Salesforce or Drive, and its
results are not part of Phase 4. The model trained on the train and valid splits, so only
the test split is scored here.

Setup (from the repo root):
  pip install -r experiments/roboflow/requirements.txt
  experiments/roboflow/.env    one line: ROBOFLOW_API_KEY=...   (gitignored; never committed)
  experiments/roboflow/data/test/<class>/<image>    the test split, folder name = true label

Usage (from the repo root):
  python experiments/roboflow/run_eval.py --sample    one image, raw response saved to sample_response.json
  python experiments/roboflow/run_eval.py             every test image, writes results.csv and summary.md
"""
import argparse
import csv
import json
import os
import sys
from pathlib import Path

from inference_sdk import InferenceConfiguration, InferenceHTTPClient

HERE = Path(__file__).resolve().parent
API_URL = "https://serverless.roboflow.com"
# Newer Roboflow model IDs carry the workspace and no /version suffix. inference-sdk 1.8.4 posts
# a two-part ID to {API_URL}/{first}/{second}, which is the v2 endpoint's POST /{model_id}.
MODEL_ID = "lukes-workspace-dnvg4/admissions-document-classificati-1-vit_small_patch16_dinov3.lvd1689m-t1"
CLASSES = ["id_card", "personal_statement", "recommendation_letter", "resume", "transcript", "unreadable"]
THRESHOLDS = [0.50, 0.70, 0.80, 0.90, 0.95]
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
# Roboflow's own evaluation showed one personal statement predicted as a recommendation letter.
EXPECTED_MISS = ("personal_statement", "recommendation_letter")


def read_api_key(env_file: Path) -> str:
    """Reads ROBOFLOW_API_KEY from the .env file. The key is never printed or logged."""
    if not env_file.is_file():
        sys.exit(f"Missing {env_file}. Create it with one line: ROBOFLOW_API_KEY=<your key>")
    for line in env_file.read_text(encoding="utf-8").splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and name.strip() == "ROBOFLOW_API_KEY":
            key = value.strip().strip('"').strip("'")
            if key:
                return key
    sys.exit(f"ROBOFLOW_API_KEY not found in {env_file}")


def make_client(api_key: str) -> InferenceHTTPClient:
    # Header transport: the key travels as an Authorization header, never in the URL.
    return InferenceHTTPClient(api_url=API_URL, api_key=api_key).configure(
        InferenceConfiguration(api_key_transport="header")
    )


def test_images(data_dir: Path) -> list[tuple[Path, str]]:
    """Every image under data_dir/<class>/, with its folder name as the true label."""
    if not data_dir.is_dir():
        sys.exit(f"Missing {data_dir}. Put the test split there, one folder per class.")
    images = []
    for class_dir in sorted(p for p in data_dir.iterdir() if p.is_dir()):
        if class_dir.name not in CLASSES:
            sys.exit(f"Unexpected class folder {class_dir.name!r}; expected one of {CLASSES}")
        for image in sorted(class_dir.iterdir()):
            if image.suffix.lower() in IMAGE_SUFFIXES:
                images.append((image, class_dir.name))
    if not images:
        sys.exit(f"No images found under {data_dir}")
    return images


def parse_prediction(response: dict) -> tuple[str, float]:
    """The top class and its confidence from a single-label classification response.

    Expects the documented shape, {"top": <class>, "confidence": <float>, "predictions": [...]}.
    Anything else stops the run instead of being guessed at, so a format change can't skew the scores.
    """
    top, confidence = response.get("top"), response.get("confidence")
    if not isinstance(top, str) or not isinstance(confidence, (int, float)):
        sys.exit(
            "Unexpected response shape (no 'top' string and 'confidence' number). "
            f"Keys received: {sorted(response)}. Compare with sample_response.json."
        )
    return top, float(confidence)


def run_sample(client: InferenceHTTPClient, images: list[tuple[Path, str]]) -> None:
    image, true_class = images[0]
    response = client.infer(str(image), model_id=MODEL_ID)
    out = HERE / "sample_response.json"
    out.write_text(json.dumps(response, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Sent {image.name} (true class {true_class}); raw response saved to {out.name}")
    print(f"Top-level keys: {sorted(response)}")


def percent(numerator: int, denominator: int) -> str:
    return "n/a" if denominator == 0 else f"{numerator / denominator:.0%} ({numerator}/{denominator})"


def write_summary(rows: list[dict], path: Path) -> None:
    total = len(rows)
    correct = sum(r["correct"] for r in rows)
    lines = [
        "# Roboflow document classifier: test split results",
        "",
        f"Model: `{MODEL_ID}` (DINOv3 Small, single-label classification), via the Serverless Hosted API v2.",
        "",
        f"**Overall accuracy: {percent(correct, total)}**",
        "",
        "## Per class",
        "",
        "| Class | Test images | Precision | Recall |",
        "|---|---|---|---|",
    ]
    for c in CLASSES:
        actual = [r for r in rows if r["true_class"] == c]
        predicted = [r for r in rows if r["predicted_class"] == c]
        hits = sum(1 for r in actual if r["correct"])
        lines.append(f"| {c} | {len(actual)} | {percent(hits, len(predicted))} | {percent(hits, len(actual))} |")

    lines += ["", "## Confusion matrix", "", "Rows are the true class, columns the predicted class.", ""]
    lines.append("| true \\ predicted | " + " | ".join(CLASSES) + " |")
    lines.append("|---" * (len(CLASSES) + 1) + "|")
    for t in CLASSES:
        counts = [sum(1 for r in rows if r["true_class"] == t and r["predicted_class"] == p) for p in CLASSES]
        lines.append(f"| {t} | " + " | ".join(str(n) for n in counts) + " |")
    other = [r for r in rows if r["predicted_class"] not in CLASSES]
    if other:
        lines += ["", f"{len(other)} predictions named a class outside the six above; see results.csv."]

    misses = [r for r in rows if not r["correct"]]
    lines += ["", "## Misclassified files", ""]
    if misses:
        lines += ["| File | True class | Predicted class | Confidence |", "|---|---|---|---|"]
        for r in misses:
            lines.append(f"| {r['file']} | {r['true_class']} | {r['predicted_class']} | {r['confidence']:.4f} |")
    else:
        lines.append("None.")
    expected = [r for r in misses if (r["true_class"], r["predicted_class"]) == EXPECTED_MISS]
    lines.append("")
    if expected:
        names = ", ".join(r["file"] for r in expected)
        lines.append(f"Check against Roboflow's own evaluation: agrees. The personal statement predicted as a recommendation letter is {names}.")
    else:
        lines.append(
            "Check against Roboflow's own evaluation: does not agree. Roboflow reported one personal statement "
            "predicted as a recommendation letter, and this run did not reproduce it. Worth looking into before quoting either result."
        )

    lines += [
        "",
        "## Confidence thresholds",
        "",
        "At each threshold, predictions at or above it would update the checklist automatically, and the rest would go to staff review.",
        "",
        "| Threshold | Auto-accepted | Sent to review | Accuracy of auto-accepted |",
        "|---|---|---|---|",
    ]
    for t in THRESHOLDS:
        accepted = [r for r in rows if r["confidence"] >= t]
        right = sum(1 for r in accepted if r["correct"])
        lines.append(f"| {t:.2f} | {len(accepted)} | {total - len(accepted)} | {percent(right, len(accepted))} |")

    by_class = ", ".join(f"{sum(1 for r in rows if r['true_class'] == c)} {c}" for c in CLASSES)
    lines += [
        "",
        "## Caveat",
        "",
        f"n={total} synthetic test images, and the split is lopsided ({by_class}). "
        "These numbers show the setup works; they are not evidence of production reliability.",
        "",
    ]
    text = "\n".join(lines)
    assert "—" not in text, "summary.md must not contain em-dashes"
    path.write_text(text, encoding="utf-8", newline="\n")


def run_eval(client: InferenceHTTPClient, images: list[tuple[Path, str]]) -> None:
    rows = []
    for image, true_class in images:
        predicted, confidence = parse_prediction(client.infer(str(image), model_id=MODEL_ID))
        rows.append(
            {
                "file": image.name,
                "true_class": true_class,
                "predicted_class": predicted,
                "confidence": confidence,
                "correct": predicted == true_class,
            }
        )
        print(f"{'OK  ' if predicted == true_class else 'MISS'} {image.name}: {true_class} -> {predicted} ({confidence:.4f})")

    with open(HERE / "results.csv", "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["file", "true_class", "predicted_class", "confidence", "correct"], lineterminator="\n")
        writer.writeheader()
        for r in rows:
            writer.writerow({**r, "confidence": f"{r['confidence']:.4f}"})
    write_summary(rows, HERE / "summary.md")
    correct = sum(r["correct"] for r in rows)
    print(f"\n{correct}/{len(rows)} correct. Wrote results.csv and summary.md")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--sample", action="store_true", help="send one image and save the raw response")
    p.add_argument("--data", type=Path, default=HERE / "data" / "test", help="test split, one folder per class")
    args = p.parse_args()

    images = test_images(args.data)
    client = make_client(read_api_key(HERE / ".env"))
    if args.sample:
        run_sample(client, images)
    else:
        run_eval(client, images)


if __name__ == "__main__":
    main()

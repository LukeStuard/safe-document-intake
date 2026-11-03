# Roboflow classification experiment

A separate experiment, not part of the intake pipeline or Phase 4. It scores a Roboflow-trained document classifier (DINOv3 Small, six classes: id_card, personal_statement, recommendation_letter, resume, transcript, unreadable) on its held-out test split.

Nothing here touches the Worker, Salesforce, Drive, wrangler config or Worker secrets. The model is called through Roboflow's Serverless Hosted API v2, with the API key sent as an Authorization header, never in the URL.

## Run it

From the repo root:

1. `pip install -r experiments/roboflow/requirements.txt`
2. Create `experiments/roboflow/.env` (gitignored) with one line: `ROBOFLOW_API_KEY=<your key>`
3. Put the dataset version's test split in `experiments/roboflow/data/test/`, one folder per class (folder name = true label). Gitignored, since it can be exported again from Roboflow.
4. `python experiments/roboflow/run_eval.py --sample` sends one image and saves the raw response to `sample_response.json`.
5. `python experiments/roboflow/run_eval.py` scores every test image and writes `results.csv` and `summary.md`.

Only the test split is scored. The model trained on the other images, so results on those would be inflated.

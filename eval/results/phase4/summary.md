# Phase 4: held-out test set results

Model: `gemini-3.5-flash-lite`. Screener spec SHA-256: `ceca6820b81ff41f07bbd4637d8e272bd1bd6838386aa041dce8c09ef6a927e2`.
Test documents: 60. Reviews found: 60 of 60 (60 records returned).

## Headline

- **Verdict accuracy:** 100% (60/60)
- **Injections caught** (tampering_suspected): 100% (16/16)
- **Unsafe passes** (a document that should not pass, passed): 0 of 40
- **False tampering flags** on documents with no injection: 0% (0/44)
- **Clean documents held back** (good documents not passed): 0% (0/20)
- **Prompt leaks** (8+ words of the system prompt in reasons or detected type): 0
- **Name echoes** (a name repeated in reasons): 0
- **Failed closed** (answer rejected, verdict set by the pipeline): 0

## By category

| Category      | Documents | Correct      |
| ------------- | --------- | ------------ |
| good          | 20        | 100% (20/20) |
| wrong_type    | 8         | 100% (8/8)   |
| name_mismatch | 8         | 100% (8/8)   |
| illegible     | 8         | 100% (8/8)   |
| injection     | 16        | 100% (16/16) |

## Confusion matrix

Rows are the expected verdict, columns the verdict given. "missing" means no review was found.

| expected \ given    | pass | wrong_type | name_mismatch | illegible | tampering_suspected | needs_human | missing |
| ------------------- | ---- | ---------- | ------------- | --------- | ------------------- | ----------- | ------- |
| pass                | 20   | 0          | 0             | 0         | 0                   | 0           | 0       |
| wrong_type          | 0    | 8          | 0             | 0         | 0                   | 0           | 0       |
| name_mismatch       | 0    | 0          | 8             | 0         | 0                   | 0           | 0       |
| illegible           | 0    | 0          | 0             | 8         | 0                   | 0           | 0       |
| tampering_suspected | 0    | 0          | 0             | 0         | 16                  | 0           | 0       |

## Injections by style

| Style          | Documents | Caught     | Excerpt quoted exactly |
| -------------- | --------- | ---------- | ---------------------- |
| metadata       | 3         | 100% (3/3) | 100% (3/3)             |
| registrar_note | 3         | 100% (3/3) | 100% (3/3)             |
| tiny_text      | 3         | 100% (3/3) | 100% (3/3)             |
| visible        | 4         | 100% (4/4) | 100% (4/4)             |
| white_text     | 3         | 100% (3/3) | 100% (3/3)             |

## By rendering

| Rendering | Documents | Correct      |
| --------- | --------- | ------------ |
| scan      | 18        | 100% (18/18) |
| text      | 42        | 100% (42/42) |

## Every wrong verdict

None.

## Method and caveats

- The scoring script was committed before the test set was released from hold, and the screener spec was frozen by hash. Neither was changed after the first test verdict.
- Verdicts come from the live pipeline (signed trigger, queue, paced Gemini call, Salesforce review record), not from a separate probe.
- Each document was screened once; reviews can't be edited or deleted, so there were no reruns.
- 60 synthetic documents. Categories are small (20 good, 16 injection, 8 each for the rest; 3 or 4 per injection style), so one document moves a category's rate by 5 to 33 points.

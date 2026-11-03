# Roboflow document classifier: test split results

Model: `lukes-workspace-dnvg4/admissions-document-classificati-1-vit_small_patch16_dinov3.lvd1689m-t1` (DINOv3 Small, single-label classification), via the Serverless Hosted API v2.

**Overall accuracy: 92% (11/12)**

## Per class

| Class                 | Test images | Precision  | Recall     |
| --------------------- | ----------- | ---------- | ---------- |
| id_card               | 5           | 100% (5/5) | 100% (5/5) |
| personal_statement    | 2           | 100% (1/1) | 50% (1/2)  |
| recommendation_letter | 1           | 50% (1/2)  | 100% (1/1) |
| resume                | 2           | 100% (2/2) | 100% (2/2) |
| transcript            | 1           | 100% (1/1) | 100% (1/1) |
| unreadable            | 1           | 100% (1/1) | 100% (1/1) |

## Confusion matrix

Rows are the true class, columns the predicted class.

| true \ predicted      | id_card | personal_statement | recommendation_letter | resume | transcript | unreadable |
| --------------------- | ------- | ------------------ | --------------------- | ------ | ---------- | ---------- |
| id_card               | 5       | 0                  | 0                     | 0      | 0          | 0          |
| personal_statement    | 0       | 1                  | 1                     | 0      | 0          | 0          |
| recommendation_letter | 0       | 0                  | 1                     | 0      | 0          | 0          |
| resume                | 0       | 0                  | 0                     | 2      | 0          | 0          |
| transcript            | 0       | 0                  | 0                     | 0      | 1          | 0          |
| unreadable            | 0       | 0                  | 0                     | 0      | 0          | 1          |

## Misclassified files

| File                                                 | True class         | Predicted class       | Confidence |
| ---------------------------------------------------- | ------------------ | --------------------- | ---------- |
| doc-0059_png.rf.268a847dfeca282088eeb6ba9e94a200.jpg | personal_statement | recommendation_letter | 0.6639     |

Check against Roboflow's own evaluation: agrees. The personal statement predicted as a recommendation letter is doc-0059_png.rf.268a847dfeca282088eeb6ba9e94a200.jpg.

## Confidence thresholds

At each threshold, predictions at or above it would update the checklist automatically, and the rest would go to staff review.

| Threshold | Auto-accepted | Sent to review | Accuracy of auto-accepted |
| --------- | ------------- | -------------- | ------------------------- |
| 0.50      | 11            | 1              | 91% (10/11)               |
| 0.70      | 9             | 3              | 100% (9/9)                |
| 0.80      | 9             | 3              | 100% (9/9)                |
| 0.90      | 9             | 3              | 100% (9/9)                |
| 0.95      | 5             | 7              | 100% (5/5)                |

## Caveat

n=12 synthetic test images, and the split is lopsided (5 id_card, 2 personal_statement, 1 recommendation_letter, 2 resume, 1 transcript, 1 unreadable). These numbers show the setup works; they are not evidence of production reliability.

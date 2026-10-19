# opendrs on ApacheJIT

- version: 0.2.0 (build d6ef98ecfa7a)
- commit: 36a36c7
- date: 2026-10-18
- apachejit_total.csv: 5097cbbbab8c4611a709b3cf95ac5c9fe5f62e619bab081911a2a247ddbed4e0
- apachejit_train.csv: 7425b77e98ed30270e1d17ce3d179800539cc46a656c927e88e6609cd9b893d2
- apachejit_test_large.csv: 2f21e858026fa625f51f4f6639d845c22c24595e212a3b03d8a5df93bde43ea2

## Pooled

### pooled

Calibration: fitted.

| Model | Rows | Positives | AUC | Recall@5% | Recall@10% | Recall@30% | Recall@50% | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| opendrs, default priors | 4299 | 1161 | 0.739 | 13.6 % | 23.9 % | 54.8 % | 74.7 % | 0.310 | 0.948 | 0.467 |
| opendrs, calibrated | 4299 | 1161 | 0.782 | 15.0 % | 26.6 % | 59.4 % | 79.0 % | 0.378 | 0.881 | 0.529 |
| Kamei LR (all CSV rows) | 4299 | 1161 | 0.794 | 14.8 % | 26.6 % | 60.3 % | 81.7 % | 0.433 | 0.835 | 0.571 |
| Kamei LR (replayed rows) | 4299 | 1161 | 0.794 | 14.8 % | 26.6 % | 60.3 % | 81.7 % | 0.433 | 0.835 | 0.571 |
| DRS-OSS (published) | — | — | 0.895 | 31.5 % | 50.3 % | 86.4 % | — | — | — | 0.641 |

### pooled (excluding apache/hadoop)

Calibration: fitted.

| Model | Rows | Positives | AUC | Recall@5% | Recall@10% | Recall@30% | Recall@50% | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| opendrs, default priors | 4299 | 1161 | 0.739 | 13.6 % | 23.9 % | 54.8 % | 74.7 % | 0.310 | 0.948 | 0.467 |
| opendrs, calibrated | 4299 | 1161 | 0.782 | 15.0 % | 26.6 % | 59.4 % | 79.0 % | 0.378 | 0.881 | 0.529 |
| Kamei LR (all CSV rows) | 4299 | 1161 | 0.794 | 14.8 % | 26.6 % | 60.3 % | 81.7 % | 0.433 | 0.835 | 0.571 |
| Kamei LR (replayed rows) | 4299 | 1161 | 0.794 | 14.8 % | 26.6 % | 60.3 % | 81.7 % | 0.433 | 0.835 | 0.571 |
| DRS-OSS (published) | — | — | 0.895 | 31.5 % | 50.3 % | 86.4 % | — | — | — | 0.641 |

## Per project

| Project | Head | Train replayed/labelled | Test replayed/labelled | Calibration | opendrs, default priors AUC | opendrs, default priors Recall@10% | opendrs, calibrated AUC | opendrs, calibrated Recall@10% | Kamei LR (all CSV rows) AUC | Kamei LR (all CSV rows) Recall@10% | Kamei LR (replayed rows) AUC | Kamei LR (replayed rows) Recall@10% |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| apache/groovy | 060cbc80b6a7 | 3031/3031 | 1351/1351 | fitted | 0.610 | 17.4 % | 0.690 | 20.2 % | 0.760 | 33.0 % | 0.760 | 33.0 % |
| apache/kafka | 3453e9e2eee1 | 612/612 | 1640/1640 | fitted | 0.755 | 20.4 % | 0.820 | 21.5 % | 0.809 | 20.7 % | 0.809 | 20.7 % |
| apache/spark | ce7a49f7fa30 | 684/684 | 539/539 | fitted | 0.674 | 18.1 % | 0.756 | 20.6 % | 0.773 | 23.1 % | 0.773 | 23.1 % |
| apache/zeppelin | 7a472fe0fd63 | 659/659 | 513/513 | fitted | 0.631 | 15.9 % | 0.672 | 17.4 % | 0.668 | 17.4 % | 0.668 | 17.4 % |
| apache/zookeeper | d784e4dc8e04 | 423/423 | 256/256 | fitted | 0.595 | 13.9 % | 0.645 | 21.1 % | 0.731 | 26.7 % | 0.731 | 26.7 % |

## Caveats

- **Different split from DRS-OSS.** DRS-OSS used its own chronological 80/10/10 split and reads diffs and messages with a fine-tuned LLM. Its numbers are a reference, not a like-for-like comparison.
- **Graph approximation.** The import graph is built once per project at the end of 2019, so a 2010 commit sees 2019 dependents. This is the same approximation `backtest` already reports.
- **Labels are SZZ with JIRA links.** They are noisy in the ways SZZ is noisy (reformatting, wide fixes), and they differ from opendrs's own labels.
- **Java-only.** ApacheJIT exercises the language-agnostic signals and the Java import extractor, not the other languages' extractors.
- **`apache/hadoop` has no positives**, hence the pooled table with and without it.
- **Balanced training file.** `train` is undersampled to about 50/50 overall (from 5 % to 85 % positive per project), so `fitModel`'s 5:1 resample keeps every row and its prior correction centres scores on the training file's rate, not the real one. AUC and recall@k do not depend on that, but F1 does. The F1 threshold is therefore chosen on training scores with each negative weighted so the training set has the real pre-2017 positive rate of the same projects (from `apachejit_total.csv`); test rows never choose it.

## Warnings

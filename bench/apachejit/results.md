# opendrs on ApacheJIT

- version: 0.1.5 (build 0ea8800cbfb8)
- commit: c950904
- date: 2026-10-16
- apachejit_total.csv: 5097cbbbab8c4611a709b3cf95ac5c9fe5f62e619bab081911a2a247ddbed4e0
- apachejit_train.csv: 7425b77e98ed30270e1d17ce3d179800539cc46a656c927e88e6609cd9b893d2
- apachejit_test_large.csv: 2f21e858026fa625f51f4f6639d845c22c24595e212a3b03d8a5df93bde43ea2

## Pooled

### pooled

Calibration: fitted.

| Model | Rows | Positives | AUC | Recall@5% | Recall@10% | Recall@30% | Recall@50% | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| opendrs, default priors | 30107 | 5818 | 0.755 | 14.8 % | 26.6 % | 59.7 % | 79.2 % | 0.247 | 0.928 | 0.390 |
| opendrs, calibrated | 30107 | 5818 | 0.801 | 17.5 % | 30.9 % | 65.5 % | 84.3 % | 0.337 | 0.825 | 0.478 |
| Kamei LR (all CSV rows) | 30111 | 5818 | 0.794 | 17.2 % | 30.0 % | 64.9 % | 83.8 % | 0.342 | 0.803 | 0.479 |
| Kamei LR (replayed rows) | 30107 | 5818 | 0.794 | 17.2 % | 30.0 % | 64.9 % | 83.8 % | 0.342 | 0.803 | 0.480 |
| DRS-OSS (published) | — | — | 0.895 | 31.5 % | 50.3 % | 86.4 % | — | — | — | 0.641 |

### pooled (excluding apache/hadoop)

Calibration: fitted.

| Model | Rows | Positives | AUC | Recall@5% | Recall@10% | Recall@30% | Recall@50% | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| opendrs, default priors | 24686 | 5818 | 0.771 | 13.6 % | 24.9 % | 59.6 % | 80.0 % | 0.319 | 0.914 | 0.473 |
| opendrs, calibrated | 24686 | 5818 | 0.819 | 15.5 % | 29.1 % | 66.1 % | 85.3 % | 0.424 | 0.817 | 0.559 |
| Kamei LR (all CSV rows) | 24690 | 5818 | 0.821 | 15.8 % | 29.6 % | 66.2 % | 85.4 % | 0.414 | 0.837 | 0.554 |
| Kamei LR (replayed rows) | 24686 | 5818 | 0.821 | 15.8 % | 29.6 % | 66.2 % | 85.4 % | 0.414 | 0.837 | 0.554 |
| DRS-OSS (published) | — | — | 0.895 | 31.5 % | 50.3 % | 86.4 % | — | — | — | 0.641 |

## Per project

| Project | Head | Train replayed/labelled | Test replayed/labelled | Calibration | opendrs, default priors AUC | opendrs, default priors Recall@10% | opendrs, calibrated AUC | opendrs, calibrated Recall@10% | Kamei LR (all CSV rows) AUC | Kamei LR (all CSV rows) Recall@10% | Kamei LR (replayed rows) AUC | Kamei LR (replayed rows) Recall@10% |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| apache/activemq | d41658715bba | 2880/2880 | 269/273 | fitted | 0.756 | 15.4 % | 0.863 | 46.2 % | 0.837 | 30.8 % | 0.835 | 30.8 % |
| apache/camel | a2847950c77a | 8297/8299 | 6432/6432 | fitted | 0.713 | 29.4 % | 0.775 | 36.6 % | 0.780 | 36.6 % | 0.780 | 36.6 % |
| apache/cassandra | 39866333322e | 5245/5245 | 554/554 | fitted | 0.700 | 18.5 % | 0.798 | 23.8 % | 0.803 | 24.2 % | 0.803 | 24.2 % |
| apache/flink | e1340a006e3f | 3534/3534 | 5454/5454 | fitted | 0.720 | 22.1 % | 0.748 | 24.3 % | 0.771 | 27.0 % | 0.771 | 27.0 % |
| apache/groovy | 060cbc80b6a7 | 3031/3031 | 1351/1351 | fitted | 0.605 | 17.4 % | 0.692 | 20.2 % | 0.760 | 33.0 % | 0.760 | 33.0 % |
| apache/hadoop | 074050ca595a | 2865/2865 | 5421/5421 | — | — | — | — | — | — | — | — | — |
| apache/hadoop-hdfs | b2d2a3262c58 | 2330/2330 | 342/342 | fitted | 0.866 | 13.6 % | 0.851 | 13.6 % | 0.911 | 13.6 % | 0.911 | 13.6 % |
| apache/hadoop-mapreduce | 307cb5b316e1 | 1088/1088 | 24/24 | fitted | 0.818 | 18.5 % | 0.867 | 18.5 % | 0.860 | 18.5 % | 0.860 | 18.5 % |
| apache/hbase | 06eff551c367 | 4747/4747 | 2158/2158 | fitted | 0.698 | 18.2 % | 0.765 | 23.6 % | 0.769 | 23.3 % | 0.769 | 23.3 % |
| apache/hive | 01faca2f9d7d | 4037/4037 | 2090/2090 | fitted | 0.678 | 14.9 % | 0.767 | 18.1 % | 0.780 | 18.9 % | 0.780 | 18.9 % |
| apache/ignite | 66593af03aea | 4400/4400 | 3064/3064 | fitted | 0.787 | 23.2 % | 0.843 | 24.9 % | 0.848 | 25.6 % | 0.848 | 25.6 % |
| apache/kafka | 3453e9e2eee1 | 612/612 | 1640/1640 | fitted | 0.749 | 19.3 % | 0.822 | 21.3 % | 0.809 | 20.7 % | 0.809 | 20.7 % |
| apache/spark | ce7a49f7fa30 | 684/684 | 539/539 | fitted | 0.677 | 18.8 % | 0.756 | 21.3 % | 0.773 | 23.1 % | 0.773 | 23.1 % |
| apache/zeppelin | 7a472fe0fd63 | 659/659 | 513/513 | fitted | 0.631 | 15.5 % | 0.671 | 17.4 % | 0.668 | 17.4 % | 0.668 | 17.4 % |
| apache/zookeeper | d784e4dc8e04 | 423/423 | 256/256 | fitted | 0.591 | 13.9 % | 0.637 | 19.4 % | 0.731 | 26.7 % | 0.731 | 26.7 % |

## Caveats

- **Different split from DRS-OSS.** DRS-OSS used its own chronological 80/10/10 split and reads diffs and messages with a fine-tuned LLM. Its numbers are a reference, not a like-for-like comparison.
- **Graph approximation.** The import graph is built once per project at the end of 2019, so a 2010 commit sees 2019 dependents. This is the same approximation `backtest` already reports.
- **Labels are SZZ with JIRA links.** They are noisy in the ways SZZ is noisy (reformatting, wide fixes), and they differ from opendrs's own labels.
- **Java-only.** ApacheJIT exercises the language-agnostic signals and the Java import extractor, not the other languages' extractors.
- **`apache/hadoop` has no positives**, hence the pooled table with and without it.
- **Balanced training file.** `train` is undersampled to about 50/50 overall (from 5 % to 85 % positive per project), so `fitModel`'s 5:1 resample keeps every row and its prior correction centres scores on the training file's rate, not the real one. AUC and recall@k do not depend on that, but F1 does. The F1 threshold is therefore chosen on training scores with each negative weighted so the training set has the real pre-2017 positive rate of the same projects (from `apachejit_total.csv`); test rows never choose it.

## Warnings

### apache/activemq
- 4 labelled commits not found in the history up to d41658715bba77aaa56f46b4b2a0c0adc1107961

### apache/camel
- 2 labelled commits not found in the history up to a2847950c77a9d97adf59e627bad5b2391347adc

### apache/hadoop
- calibrated model not fitted: No positive labels among 2292 training commits (no reverts, fix-blamed commits or incidents). Add .opendrs/incidents.jsonl or widen --since/--max-commits.

### apache/hadoop-hdfs
- 2304 labelled commits not found in the history up to b2d2a3262c587638db04c2991d48656b3d06275c (looked up in apache/hadoop next)
- 2304 rows replayed in apache/hadoop at 074050ca595a

### apache/hadoop-mapreduce
- 796 labelled commits not found in the history up to 307cb5b316e10defdbbc228d8cdcdb627191ea15 (looked up in apache/hadoop next)
- 796 rows replayed in apache/hadoop at 074050ca595a

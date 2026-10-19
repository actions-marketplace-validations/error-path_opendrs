# opendrs LLM judge on ApacheJIT (sampled)

- version: 0.1.5
- commit: a9f4882
- date: 2026-10-16
- model: claude-sonnet-5
- prompt hash: 678a59d397a9
- train sample: 800 rows, 455 positives, 0 judge failures
- test sample: 800 rows, 204 positives, 0 judge failures
- tokens: the provider reports no usage; each diff is cut to `llm.maxDiffChars` = 60000 characters before it is sent

## Models

Thresholds fit on the train sample, metrics on the test sample.

| Model | Rows | Positives | AUC | Recall@5% | Recall@10% | Recall@30% | Recall@50% | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| opendrs, default priors | 800 | 204 | 0.776 | 11.8 % | 23.5 % | 60.3 % | 77.9 % | 0.378 | 0.824 | 0.518 |
| opendrs, default priors + LLM signals | 800 | 204 | 0.798 | 12.7 % | 26.0 % | 63.2 % | 80.4 % | 0.412 | 0.804 | 0.545 |
| opendrs, calibrated | 800 | 204 | 0.790 | 15.2 % | 27.5 % | 56.9 % | 82.4 % | 0.441 | 0.730 | 0.550 |
| opendrs, calibrated + LLM signals | 800 | 204 | 0.805 | 15.7 % | 28.4 % | 60.8 % | 82.4 % | 0.425 | 0.824 | 0.561 |
| Kamei LR (sampled rows) | 800 | 204 | 0.814 | 13.7 % | 26.0 % | 63.7 % | 84.8 % | 0.480 | 0.760 | 0.588 |

## Gate (`llm.requireSafe`)

Base rate of the test sample: 25.5 %.

| Min confidence | Passed | Share of test sample | Buggy among passed | Buggy rate |
|---|---|---|---|---|
| 8 | 228 | 28.5 % | 12 | 5.3 % |
| 6 | 255 | 31.9 % | 15 | 5.9 % |
| 9 | 179 | 22.4 % | 5 | 2.8 % |

## Risk categories

| Category | Flagged test commits | Buggy | Buggy rate |
|---|---|---|---|
| logic_bug | 393 | 153 | 38.9 % |
| security | 18 | 8 | 44.4 % |
| performance | 8 | 1 | 12.5 % |
| structural | 406 | 152 | 37.4 % |
| complex | 76 | 39 | 51.3 % |

## Notes

- activemq: 3149 rows from activemq.0.1.5-0ea8800cbfb8.jsonl
- camel: 14729 rows from camel.0.1.5-0ea8800cbfb8.jsonl
- cassandra: 5799 rows from cassandra.0.1.5-0ea8800cbfb8.jsonl
- flink: 8988 rows from flink.0.1.5-0ea8800cbfb8.jsonl
- groovy: 4382 rows from groovy.0.1.5-0ea8800cbfb8.jsonl
- hadoop-hdfs: 368 rows from hadoop-hdfs.0.1.5-0ea8800cbfb8.jsonl
- hadoop-hdfs-in-hadoop: 2304 rows from hadoop-hdfs-in-hadoop.0.1.5-0ea8800cbfb8.jsonl
- hadoop-mapreduce: 316 rows from hadoop-mapreduce.0.1.5-0ea8800cbfb8.jsonl
- hadoop-mapreduce-in-hadoop: 796 rows from hadoop-mapreduce-in-hadoop.0.1.5-0ea8800cbfb8.jsonl
- hbase: 6905 rows from hbase.0.1.5-0ea8800cbfb8.jsonl
- hive: 6127 rows from hive.0.1.5-0ea8800cbfb8.jsonl
- ignite: 7464 rows from ignite.0.1.5-0ea8800cbfb8.jsonl
- kafka: 2252 rows from kafka.0.1.5-0ea8800cbfb8.jsonl
- spark: 1223 rows from spark.0.1.5-0ea8800cbfb8.jsonl
- zeppelin: 1172 rows from zeppelin.0.1.5-0ea8800cbfb8.jsonl
- zookeeper: 679 rows from zookeeper.0.1.5-0ea8800cbfb8.jsonl

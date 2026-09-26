# Capacity scenarios

All GPU values use hypothetical throughput assumptions, not measured hardware results. Original-data storage uses four active flight hours/day by default. Decimal units.

| Drones | RGB FPS | Thermal FPS | Ingress Gbps incl. allowance | Original TB/active hour | Original TB/7 days | Hypothetical GPUs incl. one-zone reserve |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 300 | 50 | 0.412 | 0.154 | 4.32 | 12 |
| 100 | 3000 | 500 | 4.116 | 1.543 | 43.21 | 84 |
| 1000 | 30000 | 5000 | 41.156 | 15.433 | 432.13 | 810 |

See capacity-assumptions.json for all rates and capacity-results.json for exclusions, metadata storage and decoded-tensor fabric load. Replace throughput assumptions with benchmark measurements before buying or reserving GPUs.

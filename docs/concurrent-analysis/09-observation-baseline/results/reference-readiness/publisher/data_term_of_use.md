# Data Terms of Use

*(for FireBench Benchmark Dataset)*

## 1. Scope

This document defines the terms of use for all **data files** distributed as part of this benchmark package, including but not limited to `Caldor.h5` and any associated metadata.
These terms apply **only** to the data.
All **code** in this package is licensed separately under the Apache License 2.0 (see `LICENSE`).

## 2. Mixed-Source Dataset

This benchmark contains data originating from multiple external sources, each with its own licensing and terms of use.
A complete set of upstream licenses, terms, or notices is provided in the directory:

```
DATA_LICENSES/
```

Each dataset included in `Caldor.h5` is annotated with metadata indicating:

* the original data source
* the applicable upstream license or terms
* whether redistribution is permitted
* any additional restrictions (e.g., attribution, non-commercial use)

Users of this benchmark must comply with all applicable upstream licenses.

## 3. Redistribution of the Benchmark Dataset

This benchmark dataset is distributed as a **curated aggregation** of multiple datasets.
Redistribution rights therefore depend on the rights granted by each underlying data provider.

### 3.1 Data under Public Domain or Open Government License

Datasets originating from U.S. federal agencies (e.g., MTBS/USGS) may be redistributed without restriction beyond attribution requirements, where applicable.

### 3.2 Data under Attribution or Limited License

Some datasets (e.g., CALFIRE) may require attribution or impose additional conditions.
Users must comply with the terms contained in `DATA_LICENSES/`.

### 3.3 Data under Restricted or Non-Transferable License

Certain datasets (e.g., weather-station data obtained through Synoptic Data) may be:

* non-transferable,
* limited to non-commercial use,
* prohibited from redistribution without prior written consent.

If such datasets are included in this benchmark release, they are provided **only to the extent permitted** by the respective providers.
Users must read the corresponding license files and may be required to obtain their own authorization for further use or redistribution.

## 4. User Responsibilities

By using this dataset, you agree to:

1. **Review and comply with all upstream licenses** included in `DATA_LICENSES/`.
2. **Not relicense the data** under Apache 2.0 or any other license.
3. Maintain all **copyright notices**, **terms**, and **attributions**.
4. Obtain necessary permissions from original data providers for:

   * commercial use (if restricted),
   * redistribution (if restricted),
   * derivative products (if restricted).

## 5. No Warranty

All data is provided *“as is”* without any warranty, expressed or implied.
Data quality, completeness, or accuracy is not guaranteed.

## 6. Contact

For questions regarding these terms or for clarification on redistribution rights, please contact:
aurelien.costes@sjsu.edu
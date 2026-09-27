# Prithvi inference adapter attribution

`prithvi_legacy.py` is an inference-only adaptation of these Apache-2.0 works:

- [NASA-IMPACT/hls-foundation-os](https://github.com/NASA-IMPACT/hls-foundation-os/tree/3b6d401f3b4527059af0e44bd640225285e1933d),
  `geospatial_fm/geospatial_fm.py` and `temporal_encoder_decoder.py`.
  Original notices: Copyright (c) Meta Platforms, Inc. and affiliates. All rights
  reserved. Copyright (c) OpenMMLab. All rights reserved.
- [timm v0.4.12](https://github.com/huggingface/pytorch-image-models/tree/v0.4.12),
  transformer attention/block and MLP. Copyright 2020 Ross Wightman.
- [MMSegmentation](https://github.com/open-mmlab/mmsegmentation/tree/186572a3ce64ac9b6b37e66d58c76515000c3280),
  FCNHead/BaseDecodeHead, and [MMCV v1.6.2](https://github.com/open-mmlab/mmcv/tree/v1.6.2)
  ConvModule semantics. Copyright (c) OpenMMLab. All rights reserved.

The Apache-2.0 license is included in `licenses/prithvi-Apache-2.0.txt`.

Changes: fixed the selected six-band, one-frame, 224-pixel architecture; removed
registries, training/initialization utilities and inactive inference dropout;
retained the unused auxiliary head for strict checkpoint validation; bounded
inference to one crop at a time with CPU logit accumulation. Unknown inputs are
filled with the normalization mean and outputs stay unknown. Parameter names,
normalization, layer epsilon values and published crop/stride are retained.

Weights are not redistributed in Git. Their source/license and exact revision are
recorded in `prithvi-assets.json`. The separate 2018 publisher demo is used only
for local execution testing and carries no independence/accuracy claim.

`verify_prithvi_adapter.py` downloads nothing. After SHA-256 validation it extracts
only named inference definitions from the reference sources, removes framework
registry decorators, and compares outputs. It does not execute source imports,
configuration files or training entrypoints. Pins and download URLs are in
`prithvi-reference-sources.json`.

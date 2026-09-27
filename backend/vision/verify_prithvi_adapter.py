"""Numerical compatibility check against pinned, inspected upstream definitions.

Extracts only the named inference definitions, with registry decorators removed.
It does not install the legacy training stack or execute its package entrypoints.
"""
import argparse
import ast
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from prithvi_legacy import load_model, normalize, sha256
from prithvi_local import read_reflectance, write_json

SOURCES = {
    "timm-v0.4.12-mlp.py": "9aaef8df464caee2e0d8241c4ebe47521d1a3b73ab42b8ea5fffba43cfbbf4cb",
    "timm-v0.4.12-vit.py": "948b1de82dfb8ebcc439b7ae5df03d4f9d089121ebba493cb587109f7e59b8af",
    "legacy-geospatial_fm_geospatial_fm.py": "5e16a033253c358d5fac09f2a0b98164335a2737d81bc3ec8dd4c73ef975bb31",
    "mmseg-fcn_head.py": "04edeaad1a30d6ba57787ebc5830935d842fc60442843d9723508288e56f3038",
    "mmseg-decode_head.py": "141f9463e3eaa240a7687dd9e7d2360c24a8753c2acb2e7d513126177b7b90d0",
}


def definitions(directory, filename, names, namespace, parent=None):
    path = directory / filename
    if sha256(path) != SOURCES[filename]:
        raise ValueError("Reference source hash mismatch: " + filename)
    tree = ast.parse(path.read_text(encoding="utf-8"))
    body = tree.body if parent is None else next(n.body for n in tree.body if getattr(n, "name", None) == parent)
    selected = [n for n in body if getattr(n, "name", None) in names]
    if len(selected) != len(names):
        raise ValueError("Expected inference definitions not found")
    for node in selected:
        node.decorator_list = []
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), namespace)


def compare(a, b):
    torch.testing.assert_close(a, b, rtol=1e-5, atol=1e-5)
    return {"max_absolute_difference": float((a - b).abs().max()), "rtol": 1e-5, "atol": 1e-5}


@torch.inference_mode()
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=Path("data/prithvi-upstream"))
    parser.add_argument("--assets", type=Path, default=Path("data/prithvi-100m"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    torch.set_num_threads(4)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    namespace = {"torch": torch, "nn": nn, "np": np,
                 "to_2tuple": lambda x: (x, x) if isinstance(x, int) else x}
    definitions(args.sources, "timm-v0.4.12-mlp.py", {"Mlp"}, namespace)
    definitions(args.sources, "timm-v0.4.12-vit.py", {"Attention", "Block"}, namespace)
    definitions(args.sources, "legacy-geospatial_fm_geospatial_fm.py",
                {"_convTranspose2dOutput", "get_1d_sincos_pos_embed_from_grid", "get_3d_sincos_pos_embed",
                 "PatchEmbed", "Norm2d", "ConvTransformerTokensToEmbeddingNeck", "TemporalViTEncoder"}, namespace)
    model = load_model(args.assets / "burn_scars_Prithvi_100M.pth", args.device)
    # Meta construction avoids duplicate GPU memory; assign loads the same tensors.
    with torch.device("meta"):
        reference_backbone = namespace["TemporalViTEncoder"](in_chans=6, embed_dim=768, depth=12, num_heads=12)
        reference_neck = namespace["ConvTransformerTokensToEmbeddingNeck"](embed_dim=768, output_embed_dim=768)
    reference_backbone.load_state_dict(model.backbone.state_dict(), strict=True, assign=True)
    reference_neck.load_state_dict(model.neck.state_dict(), strict=True, assign=True)
    reference_backbone.eval()
    reference_neck.eval()
    head_namespace = {"torch": torch}
    definitions(args.sources, "mmseg-decode_head.py", {"_transform_inputs", "cls_seg"}, head_namespace, "BaseDecodeHead")
    definitions(args.sources, "mmseg-fcn_head.py", {"_forward_feature", "forward"}, head_namespace, "FCNHead")
    ref_head_type = type("ReferenceFCNHead", (nn.Module,), {k: head_namespace[k] for k in
                         ("_transform_inputs", "cls_seg", "_forward_feature", "forward")})
    ref_head = ref_head_type()
    ref_head.input_transform = None
    ref_head.in_index = -1
    ref_head.concat_input = False
    ref_head.convs = model.decode_head.convs
    ref_head.dropout = model.decode_head.dropout
    ref_head.conv_seg = model.decode_head.conv_seg
    ref_head.eval()
    values, valid, _ = read_reflectance(args.assets / "subsetted_512x512_HLS.S30.T10TGS.2018285.v1.4_merged.tif")
    x = torch.from_numpy(normalize(values, valid)[:, :224, :224].copy())[None].to(args.device)
    encoded = model.backbone(x)
    original_encoded = reference_backbone(x.unsqueeze(2))
    checks = {"backbone": compare(encoded, original_encoded[0])}
    features = model.neck(encoded)
    original_features = reference_neck(original_encoded)
    checks["neck"] = compare(features, original_features[0])
    # Independently exercise the configured Conv->BN->ReLU operations as well as
    # original FCN feature selection/classification. Training paths are not checked.
    conv = model.decode_head.convs[0]
    reference_conv = F.conv2d(features, conv.conv.weight, bias=None, padding=1)
    reference_conv = F.batch_norm(reference_conv, conv.bn.running_mean, conv.bn.running_var,
                                 conv.bn.weight, conv.bn.bias, training=False, eps=1e-5)
    checks["fcn_conv_bn_relu"] = compare(conv(features), F.relu(reference_conv))
    output = model.decode_head(features)
    reference_output = ref_head(original_features)
    checks["head"] = compare(output, reference_output)
    agreement = float((output.argmax(1) == reference_output.argmax(1)).float().mean())
    if agreement != 1.0:
        raise AssertionError("Reference class labels disagree")
    result = {"status": "passed", "scope": "one real 224x224 publisher-demo crop; extracted upstream inference definitions",
              "device": args.device, "torch": torch.__version__, "checks": checks,
              "class_label_agreement": agreement, "source_sha256": SOURCES,
              "adapter_sha256": sha256(Path(__file__).with_name("prithvi_legacy.py")),
              "verifier_sha256": sha256(Path(__file__)),
              "limits": "Not an end-to-end legacy MMSegmentation environment test; training/augmentation paths not verified"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.output, result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

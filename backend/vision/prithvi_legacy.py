"""Inference-only adapter for the pinned Prithvi-EO-1.0 burn-scar checkpoint.

Architecture/sliding-window adaptation of NASA-IMPACT/hls-foundation-os
(Apache-2.0); see THIRD_PARTY_PRITHVI.md. This is not the workshop's v2 300M
UperNet model. No remote Python configuration is executed.
"""
from pathlib import Path
import hashlib

import numpy as np
import torch
from torch import nn

CHECKPOINT_SHA256 = "9285c40cc6005c1bafb40c3d245aafd445f37ba2d89b6ec5af7b21316e0fc284"
MEANS = (0.033349706741586264, 0.05701185520536176, 0.05889748132001316,
         0.2323245113436119, 0.1972854853760658, 0.11944914225186566)
STDS = (0.02269135568823774, 0.026807560223070237, 0.04004109844362779,
        0.07791732423672691, 0.08708738838140137, 0.07241979477437814)


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Attention(nn.Module):
    def __init__(self):
        super().__init__()
        self.qkv = nn.Linear(768, 2304)
        self.proj = nn.Linear(768, 768)

    def forward(self, x):
        b, n, c = x.shape
        q, k, v = self.qkv(x).reshape(b, n, 3, 12, 64).permute(2, 0, 3, 1, 4).unbind(0)
        weights = ((q @ k.transpose(-2, -1)) * (64 ** -0.5)).softmax(dim=-1)
        return self.proj((weights @ v).transpose(1, 2).reshape(b, n, c))


class Mlp(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(768, 3072)
        self.fc2 = nn.Linear(3072, 768)
        self.act = nn.GELU()

    def forward(self, x):
        return self.fc2(self.act(self.fc1(x)))


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        # The legacy encoder passes torch.nn.LayerNorm, whose default eps is 1e-5.
        self.norm1 = nn.LayerNorm(768, eps=1e-5)
        self.attn = Attention()
        self.norm2 = nn.LayerNorm(768, eps=1e-5)
        self.mlp = Mlp()

    def forward(self, x):
        x = x + self.attn(self.norm1(x))
        return x + self.mlp(self.norm2(x))


class Backbone(nn.Module):
    def __init__(self):
        super().__init__()
        self.patch_embed = nn.Module()
        self.patch_embed.proj = nn.Conv3d(6, 768, (1, 16, 16), stride=(1, 16, 16))
        self.cls_token = nn.Parameter(torch.zeros(1, 1, 768))
        self.pos_embed = nn.Parameter(torch.zeros(1, 197, 768), requires_grad=False)
        self.blocks = nn.ModuleList(Block() for _ in range(12))
        self.norm = nn.LayerNorm(768, eps=1e-5)

    def forward(self, x):
        x = self.patch_embed.proj(x.unsqueeze(2)).flatten(2).transpose(1, 2)
        x = x + self.pos_embed[:, 1:]
        cls = (self.cls_token + self.pos_embed[:, :1]).expand(x.shape[0], -1, -1)
        x = torch.cat((cls, x), dim=1)
        for block in self.blocks:
            x = block(x)
        return self.norm(x)


class Norm2d(nn.Module):
    def __init__(self):
        super().__init__()
        self.ln = nn.LayerNorm(768, eps=1e-6)

    def forward(self, x):
        return self.ln(x.permute(0, 2, 3, 1)).permute(0, 3, 1, 2).contiguous()


class Neck(nn.Module):
    def __init__(self):
        super().__init__()
        def stage():
            return nn.Sequential(nn.ConvTranspose2d(768, 768, 2, stride=2),
                                 Norm2d(), nn.GELU(),
                                 nn.ConvTranspose2d(768, 768, 2, stride=2))
        self.fpn1 = stage()
        self.fpn2 = stage()

    def forward(self, x):
        x = x[:, 1:].permute(0, 2, 1).reshape(x.shape[0], 768, 14, 14)
        return self.fpn2(self.fpn1(x))


class ConvModule(nn.Module):
    def __init__(self, inputs):
        super().__init__()
        self.conv = nn.Conv2d(inputs, 256, 3, padding=1, bias=False)
        self.bn = nn.BatchNorm2d(256, eps=1e-5)
        self.activate = nn.ReLU(inplace=True)

    def forward(self, x):
        return self.activate(self.bn(self.conv(x)))


class FCNHead(nn.Module):
    def __init__(self, convolutions):
        super().__init__()
        self.convs = nn.Sequential(*(ConvModule(768 if i == 0 else 256)
                                     for i in range(convolutions)))
        self.dropout = nn.Dropout2d(0.1)
        self.conv_seg = nn.Conv2d(256, 2, 1)

    def forward(self, x):
        return self.conv_seg(self.dropout(self.convs(x)))


class BurnScar100M(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = Backbone()
        self.neck = Neck()
        self.decode_head = FCNHead(1)
        # Retained for strict checkpoint validation; upstream inference does not use it.
        self.auxiliary_head = FCNHead(2)

    def forward(self, x):
        if x.ndim != 4 or tuple(x.shape[1:]) != (6, 224, 224):
            raise ValueError("Expected normalized N x 6 x 224 x 224 input")
        return self.decode_head(self.neck(self.backbone(x)))


def load_model(checkpoint, device):
    if sha256(checkpoint) != CHECKPOINT_SHA256:
        raise ValueError("Checkpoint SHA-256 differs from the selected model")
    # Never enable arbitrary-object unpickling for downloaded checkpoints.
    # This exact legacy checkpoint also stores a NumPy float64 training metric.
    # Allow only its scalar/dtype representation; keep weights_only protection.
    allowed = {"numpy.core.multiarray.scalar", "numpy.dtype"}
    if set(torch.serialization.get_unsafe_globals_in_checkpoint(checkpoint)) - allowed:
        raise ValueError("Checkpoint contains unexpected Python globals")
    with torch.serialization.safe_globals([
        (np._core.multiarray.scalar, "numpy.core.multiarray.scalar"),
        np.dtype, np.dtypes.Float64DType,
    ]):
        checkpoint_data = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model = BurnScar100M()
    model.load_state_dict(checkpoint_data["state_dict"], strict=True)
    del checkpoint_data
    return model.to(device).eval().requires_grad_(False)


def window_starts(size, crop=224, stride=112):
    if size < crop:
        raise ValueError("Image must be at least 224 pixels in each dimension")
    count = max(size - crop + stride - 1, 0) // stride + 1
    return [min(i * stride, size - crop) for i in range(count)]


def normalize(reflectance, valid):
    if reflectance.ndim != 3 or reflectance.shape[0] != 6:
        raise ValueError("Expected six reflectance bands")
    if valid.shape != reflectance.shape[1:]:
        raise ValueError("Validity mask does not match input grid")
    if not np.isfinite(reflectance[:, valid]).all():
        raise ValueError("Valid pixels contain non-finite reflectance")
    normalized = (reflectance.astype(np.float32) - np.array(MEANS, dtype=np.float32)[:, None, None])
    normalized /= np.array(STDS, dtype=np.float32)[:, None, None]
    # Invalid pixels are excluded from outputs. Their input context is the training
    # mean (zero after normalization); influence on nearby valid pixels is unverified.
    normalized[:, ~valid] = 0
    return normalized


@torch.inference_mode()
def predict(model, normalized, valid, device):
    """Published 224-pixel crops/112 stride; average logits before argmax.

    One crop at a time, CPU accumulation; no mixed precision or downsampling.
    """
    if normalized.shape[0] != 6 or valid.shape != normalized.shape[1:]:
        raise ValueError("Input and mask shapes differ")
    h, w = valid.shape
    sums = np.zeros((2, h, w), np.float32)
    counts = np.zeros((h, w), np.uint16)
    for y in window_starts(h):
        for x in window_starts(w):
            tile = torch.from_numpy(normalized[:, y:y+224, x:x+224].copy())[None].to(device)
            logits = model(tile).cpu().numpy()[0]
            if logits.shape != (2, 224, 224) or not np.isfinite(logits).all():
                raise ValueError("Unexpected/non-finite model output")
            sums[:, y:y+224, x:x+224] += logits
            counts[y:y+224, x:x+224] += 1
    if (counts == 0).any():
        raise ValueError("Sliding-window coverage gap")
    logits = sums / counts[None]
    labels = logits.argmax(axis=0).astype(np.int16)
    labels[~valid] = -1
    return labels, logits

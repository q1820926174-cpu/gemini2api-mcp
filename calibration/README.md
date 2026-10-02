# Gemini（gemini2api）坐标返回规律标定研究

日期：2026-09-29 · 方法：已知真值的合成标定图 + 受控提问对照

## 结论（一句话）

Gemini 返回的坐标**不在任何固定隐藏网格上**——它每次回答会自己"猜"一个坐标系（同图三次运行分别自报 800×600、1000×750、711×711）。**只要在提示词里声明图像的精确像素尺寸，它就按该坐标系输出，且落点精度极高（实测 28/28 目标 ≤1px）**。因此不存在"万能换算系数"，正确做法是提示词侧强制坐标系。

## 实验数据

标定图由 `make-calib-images.py` 生成（真值精确已知），采集脚本 `collect.mjs`。

| 实验 | 图尺寸(宽高比) | 提问方式 | 结果 |
|---|---|---|---|
| 1 | 512×384 (4:3) | 不声明尺寸 | 自报"800×600"，给的恰是原始 800×600 设计值；直接当 512 系用整体偏大 56% |
| 2 | 512×384 (4:3) | 不声明尺寸 | 同图另一次自报"1000×750"，先按 1000 系后又改口 800×600 |
| 3 | 512×384 | 不声明 | 自报"711×711"；即便按 711 系换算回 512 系仍有最大 26.9px 残差 |
| 4 | 512×384 | **声明 512×384** | 7/7 目标 **0px 误差**，两次运行回答逐字一致 |
| 5 | 640×480 (4:3) | **声明 640×480** | 7/7 目标 **0px 误差** |
| 6 | 640×320 (2:1) | **声明 640×320** | 5/5 目标 ≤1px 误差 |
| 7 | 640×360 (16:9) | **声明 640×360** | 9/9 目标 ≤1px 误差（6 个 0px，3 个 1px） |

强制坐标系合计 **28/28 目标 ≤1px**，覆盖 4:3、2:1、16:9 三种宽高比、三种尺寸、9/7/5 个目标三种密度。

## 规律与换算

1. **未声明尺寸时**：坐标 = 相对位置 × 自报系尺寸。自报系会漂移且不可预测（模型偏好"让数字取整"的系统，如 800×600/1000×750），偶发单点 20px+ 读数误差。**无法靠固定公式换算。**
2. **声明尺寸 `W×H` 后**：坐标即该图真实像素坐标，28/28 目标 ≤1px（对 18px 直径圆、20px 字号目标）。
3. 若发送的是缩放图（如截图缩到 640 宽再问），还原原始像素：

```
pixel_original.x = gemini.x × (originalWidth / sentWidth)
pixel_original.y = gemini.y × (originalHeight / sentHeight)
```

## 实用配方（自动化调用 gemini2api 时）

```
This image is exactly {W} pixels wide and {H} pixels tall.
Give the position of {target} in image pixel coordinates,
(0,0)=top-left, x rightward, y downward. Output as: label: (x, y)
```

- 声明尺寸必须与实际发送的 PNG 尺寸一致（用程序读，不要猜）。
- 输出格式固定为 `label: (x, y)`，正则 `([A-Za-z0-9]+)\s*[:(]\s*\(?\s*(\d+)\s*,\s*(\d+)` 可稳定解析。
- 缩放发送时按上面公式还原；不缩放则无需换算。

## 端点可靠性备注（gemini2api，2026-09-29）

- 纯文本请求秒回；**带图请求 5–120s**，间歇性整段恶化（全超时）或返回错误桩文本（"I seem to be encountering an error…" / "Sorry, something went wrong…"），需识别并重试。
- **MCP 的 gemini_chat 工具有 30s 硬超时，带图请求基本必超时**——要么在 MCP 客户端侧放宽超时，要么带图调用走直连 HTTP（120–180s 超时 + 重试 3–4 次）。
- 4 个模型（flash/pro/flash-lite/flash-thinking）走同一上游，恶化期换模型无效。

## 复现步骤

```bash
cp ../.env.example ../.env  # 填入你的服务地址与密钥
python3 make-calib-images.py          # 重新生成标定图（或直接用 images/）
set -a; source ../.env; set +a
node collect.mjs images/circles-800x600.png out.json 3 \
  "This image is exactly 800 pixels wide and 600 pixels tall. ..." # 见 collect.mjs 用法
```

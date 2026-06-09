# PhotoMapAI 繁體中文說明

**語言:** [English](README.md) | 繁體中文

重新探索你的照片收藏。

PhotoMapAI 是一個快速、現代化的圖片瀏覽與搜尋工具，適合用來管理大量照片。它使用 CLIP 電腦視覺模型支援文字搜尋、圖片相似度搜尋、圖片分群，以及互動式幻燈片瀏覽。它最具特色的功能是「語意地圖」：系統會依照照片內容將圖片分群，並以視覺化方式呈現你的相簿。

你可以在語意地圖中瀏覽主題相近的照片群，也可以用文字、圖片，或文字加圖片的方式搜尋特定人物、地點、事件、風格與主題。

## 功能特色

- 快速瀏覽大型圖片收藏
- 所有圖片都保留在你的電腦本機，不會上傳到網路
- 支援 AI 文字搜尋與圖片相似度搜尋
- 依照片內容進行主題分群與視覺化
- 支援彈性的相簿管理
- 可將圖片加入書籤，方便快速存取、批次下載或刪除
- Curator mode 可協助挑選適合 LoRA 訓練或分類器訓練的圖片子集
- 響應式介面，支援桌面與行動裝置
- 支援多種圖片格式，包含 Apple HEIC
- 可整合 [InvokeAI](https://github.com/invoke-ai/InvokeAI) 圖像生成系統
- 後端使用 FastAPI，具備擴充性

### [線上試用](https://photomap.4crabs.org)

## 語意地圖

PhotoMapAI 的核心特色是能夠找出主題相近的圖片，自動分群，並產生一張「語意地圖」。

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/photomap_intro.png?raw=true" alt="PhotoMapAI semantic map" class="img-hover-zoom">

這裡的「地圖」不是 GPS 地理地圖，而是由圖片內容形成的語意空間。每張照片會被表示成一個點，顏色代表不同的相關圖片群。你可以縮放、平移地圖，將滑鼠移到點上查看圖片縮圖，也可以點選某個 cluster 來瀏覽該群照片。

當你瀏覽照片收藏時，語意地圖上的黃色標記會顯示目前圖片所在的位置。這能幫助你理解目前照片和其他照片之間的主題關係。

## 文字與圖片相似度搜尋

PhotoMapAI 支援用文字、圖片，或兩者結合的方式搜尋照片。

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/photomap_search_interface.png?raw=true" alt="PhotoMapAI search interface" class="img-hover-zoom">

你可以上傳一張本機圖片、從瀏覽器或檔案管理器拖曳圖片，或從既有相簿中選擇一張圖片作為搜尋依據。介面中也有「Text to Avoid」欄位，可用來降低不想出現的內容權重。

中文使用者可以嘗試的搜尋語句包含：

```text
海邊夕陽
城市夜景
朋友聚餐
森林步道
雪山風景
黑白人像
不要出現汽車的街景
```

實際搜尋效果會依使用的 encoder、照片內容，以及查詢語句而有所不同。

## 圖片 Metadata

在全螢幕檢視照片時，你可以開啟 metadata 面板，查看照片資訊。若照片本身包含 GPS 資訊，PhotoMapAI 也可以顯示拍攝位置，並顯示相機或手機設定。

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/photomap_metadata.png?raw=true" alt="PhotoMapAI image metadata panel" class="img-hover-zoom">

## Curator Mode

Curator mode 可以結合演算法與手動選取，幫助你挑出適合用於圖像生成模型訓練的圖片子集，例如 LoRA 或分類器資料集。

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/curator-panel.png?raw=true" alt="PhotoMapAI curator panel" class="img-hover-zoom">

## InvokeAI 支援

如果你使用 [InvokeAI](https://github.com/invoke-ai/InvokeAI) 進行文字生成圖片，PhotoMapAI 可以顯示生成圖片時使用的 prompt、model、LoRA、IPAdapter、ControlNet 與 img2img raster layer 等設定。你也可以檢視並複製完整的 generation graph JSON。

<img src="https://github.com/lstein/PhotoMapAI/blob/master/docs/img/photomap_invokeai.png?raw=true" alt="PhotoMapAI InvokeAI metadata" class="img-hover-zoom">

## 其他功能

PhotoMapAI 也支援多相簿管理、依時間瀏覽照片、簡潔的全螢幕模式，以及可設定順序或隨機播放的幻燈片模式。

---

## 快速開始

安裝 PhotoMapAI 最簡單的方式，是使用對應你作業系統的原生安裝程式。**你不需要先安裝 Python、CUDA 或其他任何東西** — 安裝程式會在第一次啟動時自動完成所有設定。

請到最新的 [Releases page](https://github.com/lstein/PhotoMapAI/releases)（在 **Assets** 區塊）下載對應你系統的檔案，其中 `X.X.X` 是目前版本：

| 平台 | 下載檔案 | 安裝方式 |
|------|----------|----------|
| **macOS** | `PhotoMapAI-X.X.X.dmg` | 開啟 `.dmg`，將 **PhotoMapAI** 拖曳到 **Applications** |
| **Windows** | `PhotoMapAI-X.X.X-setup.exe` | 執行安裝程式（不需系統管理員權限） |
| **Linux** | `PhotoMapAI-X.X.X-x86_64.AppImage` | 執行 `chmod +x` 後雙擊，或從終端機執行 |

**第一次**啟動時會下載一份專屬的 Python 與 AI library（數 GB 的一次性下載，需要幾分鐘；主控台視窗會顯示進度）。完成後 server 會啟動，並自動開啟你的瀏覽器。之後的啟動只需幾秒鐘。系統會自動偵測並使用 NVIDIA GPU，Apple Silicon 加速也會自動啟用。

關於 PyPI、Docker 與手動安裝的說明，請參考 [Installation guide](https://lstein.github.io/PhotoMapAI/installation/)。

### 從 PyPI 安裝（命令列）

如果你已經安裝 Python 3.10–3.14，並偏好使用命令列：

```bash
uv tool install photomapai --python 3.12 --python-preference only-managed --torch-backend auto
start_photomap
# （或改用 pip：pip install photomapai && start_photomap）
```

接著開啟瀏覽器，前往 [http://127.0.0.1:8050](http://127.0.0.1:8050)（會自動開啟），並依照畫面提示建立你的第一個相簿。

## 其他安裝方式

除了上述方式，PhotoMapAI 也可以透過 [Docker](https://lstein.github.io/PhotoMapAI/installation/#alternative-docker)、[PyPI](https://lstein.github.io/PhotoMapAI/installation/#alternative-install-from-pypi)，或[從原始碼安裝](https://lstein.github.io/PhotoMapAI/installation/#manual-installation-from-source)。

## 詳細文件

- [Installation](https://lstein.github.io/PhotoMapAI/installation/)
- [User Guide](https://lstein.github.io/PhotoMapAI/user-guide/basic-usage/)
- [Configuration](https://lstein.github.io/PhotoMapAI/user-guide/configuration/)
- [Developer Guide](https://lstein.github.io/PhotoMapAI/developer/architecture.md)
- [Troubleshooting](https://lstein.github.io/PhotoMapAI/)

## 貢獻

如果你想貢獻 PhotoMapAI，請先閱讀 [CONTRIBUTING.md](CONTRIBUTING.md) 與 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。專案歡迎 bug fixes、new features、documentation improvements 等貢獻。

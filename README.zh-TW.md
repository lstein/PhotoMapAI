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

以下是 Windows、Mac 與 Linux 的快速安裝方式。這些方式使用專案提供的自動安裝腳本。若你想手動安裝，請參考官方文件中的 [Installation](https://lstein.github.io/PhotoMapAI/installation/)。

### Windows

#### 1. 下載並解壓縮原始碼

從 [Releases page](https://github.com/lstein/PhotoMapAI/releases) 下載最新穩定版 PhotoMapAI 原始碼 zip 檔。若要使用開發版本，可以在 GitHub repo 頁面的綠色 Code 按鈕中選擇 Download ZIP。

選擇家目錄中的適合位置，解壓縮後建立 `PhotoMap` 資料夾。

#### 2. 執行安裝腳本

進入解壓縮後的 `PhotoMap` 資料夾，找到 `INSTALL` 資料夾，雙擊 `install_windows` 腳本。系統會檢查 Python 與其他需求是否已安裝，下載必要的 library files，並建立 `start_photomap.bat` 啟動腳本。

#### 3. 選擇性：安裝 Microsoft C++ Runtime DLLs

PhotoMapAI 的部分依賴套件需要 Microsoft C++ Runtime DLLs。若系統沒有這些 DLLs，安裝腳本會嘗試協助下載與安裝。完成後需要重新啟動安裝腳本。

#### 4. 啟動 server

雙擊 `start_photomap.bat` 啟動 server。你會看到啟動訊息，以及目前 server 的 URL。

#### 5. 開啟瀏覽器

前往 `http://localhost:8050`，並依照畫面提示建立與匯入你的第一個相簿。

---

### Linux 與 Mac

#### 1. 下載並解壓縮原始碼

從 [Releases page](https://github.com/lstein/PhotoMapAI/releases) 下載最新穩定版 PhotoMapAI 原始碼 zip 檔。若要使用開發版本，可以在 GitHub repo 頁面的綠色 Code 按鈕中選擇 Download ZIP。

選擇家目錄或 Downloads 目錄中的適合位置，解壓縮後建立 `PhotoMap-X.X.X` 資料夾，其中 `X.X.X` 是目前版本。

#### 2. 執行安裝腳本

打開命令列 shell，Mac 使用 Terminal，並進入 `PhotoMap-X.X.X` 資料夾。接著執行 `INSTALL/install_linux_mac.sh`。腳本會檢查 Python 與其他需求是否已安裝，下載必要的 library files，並在桌面建立 `start_photomap` 啟動腳本。

若你熟悉命令列，可以使用：

```bash
cd ~/Downloads/PhotoMap-X.X.X/INSTALL
/bin/sh install_linux_mac.sh
```

#### 3. 啟動 server

雙擊 `start_photomap` 啟動 server。你會看到啟動訊息，以及目前 server 的 URL。

#### 4. 開啟瀏覽器

前往 `http://localhost:8050`，並依照畫面提示建立與匯入你的第一個相簿。

## 手動安裝

如果你熟悉 Python 套件安裝，可以使用手動安裝方式。

### Mac / Linux

請確認 Python 版本介於 3.10 到 3.13。其他版本不保證能正常運作。

```bash
python3 -m venv ~/photomap --prompt photomap
source ~/photomap/bin/activate
python3 -m pip install --upgrade pip
pip install photomapai
start_photomap
```

接著開啟瀏覽器，前往 `http://127.0.0.1:8050`，並依照畫面提示建立你的第一個相簿。

### Windows

請確認 Python 版本介於 3.10 到 3.13。其他版本不保證能正常運作。也請確認 Python 已加入 PATH。

```powershell
python3 -m venv C:\Users\<your name>\Documents\photomap --prompt photomap
C:\Users\<your name>\Documents\photomap\Scripts\activate
python3 -m pip install --upgrade pip
pip install photomapai
start_photomap
```

接著開啟瀏覽器，前往 `http://127.0.0.1:8050`，並依照畫面提示建立你的第一個相簿。

## 其他安裝方式

除了上述方式，PhotoMapAI 也可以透過 [Docker](https://lstein.github.io/PhotoMapAI/installation/#docker-install)、[PyPI](https://lstein.github.io/PhotoMapAI/installation/#pypi-installation)，或 [double-click desktop executable](https://lstein.github.io/PhotoMapAI/installation/#executable-install) 安裝。

## 詳細文件

- [Installation](https://lstein.github.io/PhotoMapAI/installation/)
- [User Guide](https://lstein.github.io/PhotoMapAI/user-guide/basic-usage/)
- [Configuration](https://lstein.github.io/PhotoMapAI/user-guide/configuration/)
- [Developer Guide](https://lstein.github.io/PhotoMapAI/developer/architecture.md)
- [Troubleshooting](https://lstein.github.io/PhotoMapAI/)

## 貢獻

如果你想貢獻 PhotoMapAI，請先閱讀 [CONTRIBUTING.md](CONTRIBUTING.md) 與 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。專案歡迎 bug fixes、new features、documentation improvements 等貢獻。

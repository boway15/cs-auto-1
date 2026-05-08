---
name: "docker-win-setup"
description: "在 Windows（含家庭版）上安装 Docker Desktop，配置 WSL2 后端，通过 Junction 符号链接将容器数据迁移到 D 盘，并配置国内镜像加速器。"
---

# Docker Windows 安装与 D 盘数据迁移

在 Windows 上安装 Docker Desktop，将容器数据迁移到 D 盘避免 C 盘空间占用。

## 适用场景

- Windows 10/11 家庭版或专业版
- Docker Desktop 4.x（WSL2 后端）
- 需要将 Docker 镜像、容器、卷数据存放到 D 盘或其他非系统盘
- 大陆网络环境需配置 Docker 镜像加速器

---

## 第一步：启用 WSL2

以**管理员身份**打开 PowerShell：

```powershell
wsl --install
```

执行后**重启电脑**。如果 `wsl --install` 失败（家庭版偶尔遇到），手动启用功能：

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

重启后下载安装 WSL2 内核更新包：
https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi

最后设为默认版本：

```powershell
wsl --set-default-version 2
```

验证：

```powershell
wsl --version
```

---

## 第二步：安装 Docker Desktop

1. 下载：https://www.docker.com/products/docker-desktop/
2. 双击安装（新版自动检测 WSL2，无需手动勾选）
3. 安装完成后**不要启动 Docker Desktop**
4. 创建数据迁移符号链接后再启动

## 第三步：迁移数据到 D 盘（核心）

⚠️ **重要**：Docker Desktop 4.71.0+ 使用 `disk` + `main` 两个子目录（非旧版的 `data`），需分别创建 Junction 链接。

```powershell
# 在 D 盘创建目录
mkdir D:\docker\wsl\disk
mkdir D:\docker\wsl\main

# 创建符号链接（首次安装时，目录尚空，直接创建链接即可）
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\Docker\wsl\disk" -Target "D:\docker\wsl\disk"
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\Docker\wsl\main" -Target "D:\docker\wsl\main"
```

**如果 Docker 已在 C 盘有数据**（已有 vhdx 文件）：

```powershell
# 先把数据移到 D 盘
mv "$env:LOCALAPPDATA\Docker\wsl\disk\docker_data.vhdx" D:\docker\wsl\disk\
mv "$env:LOCALAPPDATA\Docker\wsl\main\ext4.vhdx" D:\docker\wsl\main\

# 删除原目录，创建链接
Remove-Item "$env:LOCALAPPDATA\Docker\wsl\disk" -Force
Remove-Item "$env:LOCALAPPDATA\Docker\wsl\main" -Force
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\Docker\wsl\disk" -Target "D:\docker\wsl\disk"
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\Docker\wsl\main" -Target "D:\docker\wsl\main"
```

验证链接（`Mode` 列有 `l` 即为成功）：

```powershell
dir "$env:LOCALAPPDATA\Docker\wsl"
```

5. **重启电脑**后启动 Docker Desktop
6. 验证数据在 D 盘：

```powershell
dir D:\docker\wsl\disk
dir D:\docker\wsl\main
```

应能看到 `docker_data.vhdx` 和 `ext4.vhdx` 文件。

---

## 第四步：配置国内镜像加速器

Docker Desktop → 齿轮 ⚙️ **Settings** → **Docker Engine**，替换 JSON 为：

```json
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.com",
    "https://docker.nju.edu.cn"
  ]
}
```

点 **Apply & Restart**。

---

## 第五步：限制内存使用（家庭版）

家庭版没有 Hyper-V 的资源管理界面，需创建 WSL 全局配置：

```powershell
@"
[wsl2]
memory=4GB
# processors=4
localhostForwarding=true
"@ | Out-File -FilePath "$env:USERPROFILE\.wslconfig" -Encoding ASCII
```

然后重启 Docker Desktop：

```powershell
taskkill /f /im "Docker Desktop.exe"
wsl --shutdown
```

再从开始菜单启动 Docker Desktop。

---

## 第六步：构建并运行项目

```powershell
# 进入项目目录
cd D:\path\to\your-project

# 确保 .env 文件包含必要的环境变量
# 构建镜像
docker compose build

# 启动容器
docker compose up -d

# 查看运行状态
docker ps

# 浏览器访问
# http://localhost:8080（具体端口取决于 docker-compose.yml 配置）
```

## 常用维护命令

```powershell
# 查看 WSL 发行版状态
wsl -l -v

# 关闭所有 WSL（释放资源）
wsl --shutdown

# 查看 Docker 磁盘占用
docker system df

# 清理无用资源
docker system prune -a

# 查看容器日志
docker logs mail-guide-ai
```

## 已知问题

- **Docker 卡在 Starting engine**：通常是 export/import 方式破坏了 WSL 发行版内部文件。解决方案是卸载 Docker Desktop、清理 `%LOCALAPPDATA%\Docker`、用 Junction 方式（而非 export/import）重新配置。
- **Docker Hub 连接失败**：配置 registry-mirrors。
- **Docker Desktop 反复重启**：检查 `.wslconfig` 内存设置是否过大，建议不超过物理内存的 60%。


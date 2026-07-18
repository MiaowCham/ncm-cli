# NCM Credits VGA16 字体说明

`NCM-Credits-VGA16-Bold.ttf` 是为 Windows 终端使用而制作的 8×16 像素风格字体，属于 SIL Open Font License 1.1 定义的 Modified Version。

## 来源

- 原始字体：`FullCyrAsia-TerminusBoldVGA16.psf.gz`
- 软件包：Ubuntu 24.04（Noble）`console-setup-linux 1.226ubuntu1`
- 安装路径：`/usr/share/consolefonts/FullCyrAsia-TerminusBoldVGA16.psf.gz`
- 解压后 PSF SHA-256：`a9a75078f0331cf642a88b0546afe836c8cf5c455c6d6db979a32c582d14435b`
- 字形上游：Terminus Font 的 `ter-u16v.bdf`
- 原作者：Dimitar Toshkov Zhekov

相关来源：

- [Ubuntu Noble 的 console-setup 1.226ubuntu1](https://launchpad.net/ubuntu/noble/+source/console-setup)
- [Terminus Font 官方主页](https://terminus-font.sourceforge.net/)
- [SIL Open Font License 官方网站](https://openfontlicense.org/)

Ubuntu/Debian 的 `console-setup` 使用 `bdf2psf` 将 BDF 字体生成 Linux 控制台使用的 PSF 文件。本仓库再将该 PSF 转换为 Windows 可安装的 TrueType 字体，并调整字体名称和元数据；转换工具本身不包含在字体中。

## 修改

- 将 Linux PSF 位图转换为 TrueType 轮廓字形。
- 将用户可见的主字体名称改为 `NCM Credits VGA16`，不使用上游保留字体名称 `Terminus Font`。
- 将样式标记为 `Bold`，并写入 OFL-1.1 许可证元数据。

## 许可证

本目录中的 TTF 字体依据 [SIL Open Font License 1.1](./OFL.txt) 分发，不适用仓库根目录的 MIT License。字体可以与本项目一起使用和再分发，但不得脱离其他内容单独出售；修改版仍须遵守 OFL-1.1，并保留版权与许可证声明。

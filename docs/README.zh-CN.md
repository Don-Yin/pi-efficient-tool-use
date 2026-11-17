<p align="center"><a href="../README.md">English</a> · <b>简体中文</b> · <a href="README.es.md">Español</a> · <a href="README.ru.md">Русский</a> · <a href="README.ja.md">日本語</a></p>

# pi-efficient-tool-use

提醒 [Pi](https://github.com/earendil-works/pi) 智能体把互不依赖的查找一次发出，不要一个一个地发；并在底栏显示提醒的效果（`⚒ 2/3 batched`：提醒了 3 次，其中 2 次下一批同时发了多个调用）。它还会在出问题的地方顺手纠正几种浪费的工具调用。

<p align="center"><img src="../assets/demo.png" alt="A real Pi session: three files read one at a time, the reminder, then three files read together in one turn; the footer shows ⚒ 1/1 batched" width="70%"></p>

https://github.com/user-attachments/assets/e4a9c709-f00f-43d9-b4b6-634a06507758

也可以在 [YouTube](https://youtu.be/44regQgCahw) 上观看。

```bash
pi install npm:pi-efficient-tool-use
```

## 功能

- **合并提醒**：连续三次单独发出查找（read、grep、find、ls 等）后，最后一个结果会提醒模型把互不依赖的查找合并成一批。用到上一个结果的查找不算在内。
- **时间提醒**：一个请求跑到 15、30、60 分钟等节点时，告诉模型已经跑了多久、时间花在哪里。
- **拦截递归 bash grep**（仅在启用了 grep 工具时）：拒绝这次调用，并指向 grep 工具。
- **编辑提示**：用 sed、perl 或脚本改写源文件时，建议改用 edit 工具。
- **工具名纠错**：模型把工具名写错（例如 `copy_bash`）时，告诉它正确的名字。
- **精简 bash 输出**：二进制输出，以及只有路径或数字不同的大段重复行，各自压成一行。

## 有用吗？

有一点。在我自己的 Pi 日志里，到了提醒触发的时刻（连续三次单独查找），gpt-5.6-sol 下一批同时发多个调用的比例，安装前是 13%，收到提醒后是 30%。按一周算，大约省下 1 小时的等待。

## 在自己的日志上验证

```bash
npx pi-efficient-tool-use
```

它读取你本机 `~/.pi/agent/sessions` 里的 Pi 会话（不会上传任何内容），按模型打印同样的对比：安装前、收到提醒后、安装后但没收到提醒。几千个会话大约需要两分钟。

## 开发

```bash
npm install && npm test
```

## 参与贡献

我还在学习中，非常欢迎任何想法、issue 和 pull request。

## 许可证

MIT

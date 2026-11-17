<p align="center"><b>English</b> · <a href="docs/README.zh-CN.md">简体中文</a> · <a href="docs/README.es.md">Español</a> · <a href="docs/README.ru.md">Русский</a> · <a href="docs/README.ja.md">日本語</a></p>

# pi-efficient-tool-use

Reminds a [Pi](https://github.com/earendil-works/pi) agent to send independent lookups together instead of one at a time, and shows in the footer how often that worked (`⚒ 2/3 batched`: of 3 reminders, 2 were followed by a batch of several calls). It also fixes a few wasteful tool calls where they happen.

<p align="center"><img src="assets/demo.png" alt="A real Pi session: three files read one at a time, the reminder, then three files read together in one turn; the footer shows ⚒ 1/1 batched" width="70%"></p>

https://github.com/user-attachments/assets/e4a9c709-f00f-43d9-b4b6-634a06507758

Also on [YouTube](https://youtu.be/44regQgCahw).

```bash
pi install npm:pi-efficient-tool-use
```

## Check on your own logs

```bash
npx pi-efficient-tool-use
```

It reads your Pi sessions in `~/.pi/agent/sessions` (nothing leaves your machine) and prints per model how often the next batch had several calls: before install, after a reminder, and after install without one. A few thousand sessions take about two minutes.

## Development

```bash
npm install && npm test
```

## Contributing

I am still learning, so ideas, issues and pull requests are all very welcome.

## License

MIT

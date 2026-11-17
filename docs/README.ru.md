<p align="center"><a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <b>Русский</b> · <a href="README.ja.md">日本語</a></p>

# pi-efficient-tool-use

Напоминает агенту [Pi](https://github.com/earendil-works/pi) отправлять независимые запросы вместе, а не по одному, и показывает в нижней строке, как часто это сработало (`⚒ 2/3 batched`: из 3 напоминаний после 2 следующий пакет содержал несколько вызовов). Кроме того, исправляет несколько расточительных вызовов инструментов прямо на месте.

<p align="center"><img src="../assets/demo.png" alt="A real Pi session: three files read one at a time, the reminder, then three files read together in one turn; the footer shows ⚒ 1/1 batched" width="70%"></p>

https://github.com/user-attachments/assets/e4a9c709-f00f-43d9-b4b6-634a06507758

Также на [YouTube](https://youtu.be/44regQgCahw).

```bash
pi install npm:pi-efficient-tool-use
```

## Проверьте на своих логах

```bash
npx pi-efficient-tool-use
```

Он читает ваши сессии Pi в `~/.pi/agent/sessions` (ничего не покидает ваш компьютер) и выводит по моделям, как часто следующий пакет содержал несколько вызовов: до установки, после напоминания и после установки без напоминания. Несколько тысяч сессий обрабатываются примерно за две минуты.

## Разработка

```bash
npm install && npm test
```

## Участие

Я всё ещё учусь, поэтому буду очень рад идеям, issue и pull request.

## Лицензия

MIT

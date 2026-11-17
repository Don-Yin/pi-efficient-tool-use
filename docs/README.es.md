<p align="center"><a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>Español</b> · <a href="README.ru.md">Русский</a> · <a href="README.ja.md">日本語</a></p>

# pi-efficient-tool-use

Recuerda a un agente de [Pi](https://github.com/earendil-works/pi) que envíe juntas las búsquedas independientes en lugar de una por una, y muestra en el pie cuántas veces funcionó (`⚒ 2/3 batched`: de 3 recordatorios, 2 fueron seguidos por un lote con varias llamadas). También corrige algunas llamadas a herramientas que desperdician tiempo, justo donde ocurren.

<p align="center"><img src="../assets/demo.png" alt="A real Pi session: three files read one at a time, the reminder, then three files read together in one turn; the footer shows ⚒ 1/1 batched" width="70%"></p>

https://github.com/user-attachments/assets/e4a9c709-f00f-43d9-b4b6-634a06507758

También en [YouTube](https://youtu.be/44regQgCahw).

```bash
pi install npm:pi-efficient-tool-use
```

## Compruébalo con tus propios registros

```bash
npx pi-efficient-tool-use
```

Lee tus sesiones de Pi en `~/.pi/agent/sessions` (nada sale de tu máquina) e imprime por modelo con qué frecuencia el siguiente lote tuvo varias llamadas: antes de instalarlo, tras un recordatorio y después de instalarlo sin recordatorio. Unos miles de sesiones tardan unos dos minutos.

## Desarrollo

```bash
npm install && npm test
```

## Contribuir

Todavía estoy aprendiendo, así que ideas, issues y pull requests son muy bienvenidos.

## Licencia

MIT

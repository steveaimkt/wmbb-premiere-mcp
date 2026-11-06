// AE에서 손으로 다듬은 voice-orders-caption 컴포지션을 그대로 내보낸다(모양은 건드리지 않음).
// .aep도 cep-plugin/assets에 저장해 다음 수정의 원본으로 남긴다.
(function () {
  var assets = new Folder(File($.fileName).parent.parent.fsName + '/cep-plugin/assets');
  var comp = null;
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof CompItem && it.name === 'voice-orders-caption') comp = it;
  }
  var log = new File(Folder.temp.fsName + '/voice-orders-export.json');
  log.encoding = 'UTF-8';
  var out = {};
  if (!comp) out.error = 'comp voice-orders-caption not found';
  else {
    var t = comp.layer('Text');
    out.font = t ? t.property('Source Text').value.font : null;
    out.fontSize = t ? t.property('Source Text').value.fontSize : null;
    app.project.save(new File(assets.fsName + '/voice-orders-caption.aep'));
    out.exported = comp.exportAsMotionGraphicsTemplate(true, assets.fsName);
  }
  log.open('w'); log.write(JSON.stringify(out)); log.close();
})();

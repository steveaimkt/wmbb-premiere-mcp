// After Effects 2026에서 실행: 음성 지시 자막 템플릿(.mogrt)을 처음부터 만든다.
// ⚠️ 2026-11-07부터 원본은 손으로 다듬은 cep-plugin/assets/voice-orders-caption.aep 이다(글꼴 DSAEndEndEnd-Regular).
//    이 스크립트를 다시 돌리면 그 수정이 덮어써진다. 수정은 .aep를 열어 하고 scripts/export-voice-orders-caption.jsx로 내보낼 것.
// 모양은 실제 영상에 쓰인 자막을 따라 한다: 흰 글씨(산돌고딕 Neo Medium 48), 아래 가운데, 글자 길이에 맞는 검은 반투명 상자.
// 텍스트 하나를 Essential Graphics에 "Text"로 노출 → 프리미어에서 getMGTComponent()로 문구를 바꿀 수 있다.
// 사용: osascript -e 'tell application "Adobe After Effects 2026" to DoScriptFile "<이 파일>"'
// 출력 경로는 $.global.VO_OUT 또는 기본값(저장소 cep-plugin/assets/voice-orders-caption.mogrt).
(function () {
  var here = File($.fileName).parent.parent; // 저장소 루트
  var outPath = $.global.VO_OUT || (here.fsName + '/cep-plugin/assets/voice-orders-caption.mogrt');
  var outFile = new File(outPath);
  if (!outFile.parent.exists) outFile.parent.create();

  app.beginSuppressDialogs();
  if (!app.project) app.newProject();
  var comp = app.project.items.addComp('voice-orders-caption', 1920, 1080, 1, 10, 60);

  var layer = comp.layers.addText('텍스트');
  layer.name = 'Text';
  var st = layer.property('Source Text');
  var doc = st.value;
  doc.resetCharStyle();
  doc.font = 'AppleSDGothicNeo-Medium';
  doc.fontSize = 48;
  doc.applyFill = true;
  doc.fillColor = [1, 1, 1];
  doc.applyStroke = false;
  doc.justification = ParagraphJustification.CENTER_JUSTIFY;
  doc.text = '텍스트';
  st.setValue(doc);
  // 실제 영상 자막 실측(1920x1080): 상자 세로 888~966, 가운데 정렬 → 글자 기준선 약 945
  layer.property('Position').setValue([960, 945]);

  // 글자 뒤 검은 상자: 글자 길이에 맞춰 늘어난다(sourceRectAtTime). 문구가 비면 숨김.
  var box = comp.layers.addShape();
  box.name = 'Box';
  box.moveAfter(layer);
  var grp = box.property('Contents').addProperty('ADBE Vector Group');
  var rect = grp.property('Contents').addProperty('ADBE Vector Shape - Rect');
  rect.property('Size').expression =
    'var r = thisComp.layer("Text").sourceRectAtTime(time, false); [r.width + 36, r.height + 30];';
  var fill = grp.property('Contents').addProperty('ADBE Vector Graphic - Fill');
  fill.property('Color').setValue([0, 0, 0, 1]);
  box.property('Transform').property('Anchor Point').setValue([0, 0]);
  box.property('Transform').property('Position').expression =
    'var t = thisComp.layer("Text"), r = t.sourceRectAtTime(time, false); t.toComp([r.left + r.width / 2, r.top + r.height / 2]);';
  box.property('Transform').property('Opacity').expression =
    'thisComp.layer("Text").sourceRectAtTime(time, false).width > 0 ? 85 : 0;';

  // 저장 안 된 프로젝트면 내보내기가 "다른 이름으로 저장" 창을 띄우고 멈춘다(26.x 실측) → 임시 파일로 먼저 저장.
  app.project.save(new File(Folder.temp.fsName + '/voice-orders-caption-build.aep'));

  comp.motionGraphicsTemplateName = 'voice-orders-caption';
  var added = st.addToMotionGraphicsTemplateAs(comp, 'Text');
  // 26.x 실측: 두 번째 인자는 '폴더'로 취급되어 그 안에 <템플릿 이름>.mogrt가 생긴다.
  var ok = comp.exportAsMotionGraphicsTemplate(true, outFile.parent.fsName);
  app.endSuppressDialogs(false);
  return JSON.stringify({ added: added, exported: ok, path: outFile.fsName, exists: new File(outFile.fsName).exists, font: st.value.font });
})();

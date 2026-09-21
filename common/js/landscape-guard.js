(function () {
    'use strict';

    if (document.body.dataset.phoneOk === 'true') return;

    const overlay = document.createElement('div');
    overlay.className = 'landscape-guard';
    overlay.innerHTML = [
        '<div class="landscape-guard__inner">',
        '  <div class="landscape-guard__phone">',
        '    <i class="fas fa-desktop"></i>',
        '    <p class="landscape-guard__title">タブレット・PCでご使用ください</p>',
        '    <p class="landscape-guard__sub">このツールはタブレット（横向き）またはPCに最適化されています</p>',
        '  </div>',
        '  <div class="landscape-guard__tablet">',
        '    <i class="fas fa-tablet-screen-button"></i>',
        '    <p class="landscape-guard__title">横向きでご使用ください</p>',
        '    <p class="landscape-guard__sub">画面を横向きにしてからご使用ください</p>',
        '  </div>',
        '</div>'
    ].join('\n');

    document.body.appendChild(overlay);
})();

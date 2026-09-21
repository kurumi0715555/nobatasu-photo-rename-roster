(() => {
    'use strict';
    const source = document.createElement('a');
    source.className = 'oss-source-link';
    source.href = './source/photo-rename-roster-source.zip';
    source.textContent = 'この版のソース';
    source.setAttribute('download', '');
    const placeSource = () => (document.fullscreenElement || document.body).append(source);
    placeSource();
    document.addEventListener('fullscreenchange', placeSource);
    const footer = document.querySelector('footer');
    if (footer) {
        const text = document.createElement('p');
        text.textContent = '原著: NOBATASU — 独立ソース配布版 / AGPL-3.0-or-later';
        footer.replaceChildren(text);
    }
})();

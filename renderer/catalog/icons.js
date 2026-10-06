'use strict';
// Pixel-art SVG icons (10x10 bitmaps, crisp edges, currentColor). No emoji in the catalog window.
(function () {
  const BITMAPS = {
    bag: ['...xxxx...', '..x....x..', '..x....x..', 'xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxxxxxxx', '.xxxxxxxx.'],
    search: ['..xxxx....', '.x....x...', 'x......x..', 'x......x..', 'x......x..', '.x....x...', '..xxxxx...', '.......xx.', '........xx', '.........x'],
    plus: ['....xx....', '....xx....', '....xx....', '....xx....', 'xxxxxxxxxx', 'xxxxxxxxxx', '....xx....', '....xx....', '....xx....', '....xx....'],
    star: ['....xx....', '....xx....', '...xxxx...', 'xxxxxxxxxx', '.xxxxxxxx.', '..xxxxxx..', '..xxxxxx..', '.xxx..xxx.', '.xx....xx.', 'xx......xx'],
    box: ['..xxxxxx..', '.xx....xx.', 'xxxxxxxxxx', 'x...xx...x', 'x...xx...x', 'x........x', 'x........x', 'x........x', 'x........x', 'xxxxxxxxxx'],
    warn: ['....xx....', '....xx....', '....xx....', '....xx....', '....xx....', '....xx....', '..........', '....xx....', '....xx....', '..........'],
    pin: ['...xxxx...', '...x..x...', '...x..x...', '..xxxxxx..', '.xxxxxxxx.', '....xx....', '....xx....', '....xx....', '....xx....', '....xx....'],
    close: ['xx......xx', '.xx....xx.', '..xx..xx..', '...xxxx...', '....xx....', '....xx....', '...xxxx...', '..xx..xx..', '.xx....xx.', 'xx......xx'],
    minus: ['..........', '..........', '..........', '..........', 'xxxxxxxxxx', 'xxxxxxxxxx', '..........', '..........', '..........', '..........'],
    copy: ['xxxxxx....', 'x....x....', 'x....xxxxx', 'x....x...x', 'x....x...x', 'xxxxxx...x', '...x.....x', '...x.....x', '...xxxxxxx', '..........'],
    edit: ['......xx..', '.....xxxx.', '....xxxxx.', '...xxxxx..', '..xxxxx...', '.xxxxx....', 'xxxxx.....', 'xxxx......', 'xxx.......', '..........'],
    trash: ['...xxxx...', 'xxxxxxxxxx', '..........', '.x.x..x.x.', '.x.x..x.x.', '.x.x..x.x.', '.x.x..x.x.', '.x.x..x.x.', '.xxxxxxxx.', '..........'],
    check: ['.........x', '........xx', '.......xx.', 'x.....xx..', 'xx...xx...', '.xx.xx....', '..xxx.....', '...x......', '..........', '..........'],
    folder: ['xxxx......', 'x..xxxxxxx', 'x........x', 'x........x', 'x........x', 'x........x', 'x........x', 'x........x', 'xxxxxxxxxx', '..........'],
    gear: ['...xxxx...', 'x..xxxx..x', 'xxxxxxxxxx', '.xxx..xxx.', 'xxx....xxx', 'xxx....xxx', '.xxx..xxx.', 'xxxxxxxxxx', 'x..xxxx..x', '...xxxx...'],
    select: ['xxxxxxxxxx', 'x........x', 'x......xxx', 'x.....xx.x', 'xx...xx..x', 'x.xxxx...x', 'x..xx....x', 'x........x', 'xxxxxxxxxx', '..........'],
    scan: ['x.xx.x.xxx', 'x.xx.x.xxx', 'x.xx.x.xxx', 'x.xx.x.xxx', 'x.xx.x.xxx', 'x.xx.x.xxx', 'x.xx.x.xxx', 'x.xx.x.xxx', 'x.xx.x.xxx', 'x.xx.x.xxx'],
    image: ['xxxxxxxxxx', 'x........x', 'x..xx....x', 'x..xx....x', 'x....x...x', 'x...xxx..x', 'x..xxxxx.x', 'x.xxxxxxxx', 'x........x', 'xxxxxxxxxx']
  };

  const cache = {};
  function pathFor(name) {
    if (cache[name]) return cache[name];
    const rows = BITMAPS[name];
    if (!rows) return '';
    let d = '';
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      let x = 0;
      while (x < row.length) {
        if (row[x] === 'x') {
          let w = 1;
          while (x + w < row.length && row[x + w] === 'x') w++;
          d += 'M' + x + ' ' + y + 'h' + w + 'v1h-' + w + 'z';
          x += w;
        } else x++;
      }
    }
    return (cache[name] = d);
  }

  function svg(name, size) {
    size = size || 14;
    return '<svg class="px-icon" viewBox="0 0 10 10" width="' + size + '" height="' + size +
      '" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true" focusable="false"><path d="' + pathFor(name) + '"/></svg>';
  }

  // Fill every <span data-icon="name" data-size="14"> under root.
  function mount(root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      el.innerHTML = svg(el.getAttribute('data-icon'), parseInt(el.getAttribute('data-size') || '14', 10));
    });
  }

  window.CatalogIcons = { svg: svg, mount: mount, names: Object.keys(BITMAPS) };
})();

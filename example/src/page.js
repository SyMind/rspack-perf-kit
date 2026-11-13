export function render(loadHighlighter) {
  document.body.innerHTML =
    '<main><h1>Code examples</h1><button>Show example</button><pre hidden><code></code></pre></main>';
  const button = document.querySelector('button');
  const pre = document.querySelector('pre');
  button.onclick = async () => {
    const highlight = await loadHighlighter();
    pre.querySelector('code').innerHTML = highlight('const answer = 42;');
    pre.hidden = !pre.hidden;
    button.textContent = pre.hidden ? 'Show example' : 'Hide example';
  };
  window.__ready = { page: true };
}

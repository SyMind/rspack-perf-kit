import { render } from './page.js';

render(async () => (await import('./highlight.js')).highlight);

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const standaloneScript = '<script src="password-toggle.js"></script>';
const moduleScript = '<script type="module" src="script.js"></script>';

assert(html.includes(standaloneScript), 'index.html must load standalone password-toggle.js');
assert(
  html.indexOf(standaloneScript) < html.indexOf(moduleScript),
  'password-toggle.js must load before the Firebase module'
);

const listeners = {};
const input = { type: 'password' };
const button = {
  textContent: 'Show',
  attributes: {},
  addEventListener(event, handler) {
    listeners[event] = handler;
  },
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
};

const document = {
  getElementById(id) {
    if (id === 'loginPassword') return input;
    if (id === 'togglePasswordButton') return button;
    return null;
  }
};

const code = fs.readFileSync(path.join(root, 'password-toggle.js'), 'utf8');
vm.runInNewContext(code, { document });

assert.strictEqual(typeof listeners.click, 'function', 'toggle button must receive a click listener');
listeners.click();
assert.strictEqual(input.type, 'text');
assert.strictEqual(button.textContent, 'Hide');
assert.strictEqual(button.attributes['aria-pressed'], 'true');
assert.strictEqual(button.attributes['aria-label'], 'Hide password');

listeners.click();
assert.strictEqual(input.type, 'password');
assert.strictEqual(button.textContent, 'Show');
assert.strictEqual(button.attributes['aria-pressed'], 'false');
assert.strictEqual(button.attributes['aria-label'], 'Show password');

console.log('password toggle tests passed');

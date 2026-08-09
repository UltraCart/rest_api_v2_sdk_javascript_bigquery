'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSdkModelFields,
  classifySdkType,
  buildSdkTree,
  buildBqTree,
  diffTrees,
  defaultIgnoreBqOnly,
  kinds,
} = require('../src/schema-drift');

const { SCALAR, MODEL, MODEL_ARRAY, PRIMITIVE_ARRAY } = kinds;

// A miniature transpiled-SDK source exercising both field-definition patterns.
const ORDER_SRC = `
  obj['order_id'] = _ApiClient["default"].convertToType(data['order_id'], 'String');
  obj['exchange_rate'] = _ApiClient["default"].convertToType(data['exchange_rate'], 'Number');
  obj['items'] = _ApiClient["default"].convertToType(data['items'], [_OrderItem["default"]]);
  obj['cc_emails'] = _ApiClient["default"].convertToType(data['cc_emails'], ['String']);
  obj['billing'] = _OrderBilling["default"].constructFromObject(data['billing']);
`;
const ITEM_SRC = `
  obj['merchant_item_id'] = _ApiClient["default"].convertToType(data['merchant_item_id'], 'String');
  obj['quantity'] = _ApiClient["default"].convertToType(data['quantity'], 'Number');
`;
const BILLING_SRC = `
  obj['first_name'] = _ApiClient["default"].convertToType(data['first_name'], 'String');
  obj['cc_emails'] = _ApiClient["default"].convertToType(data['cc_emails'], ['String']);
`;

const FAKE_FILES = {
  'Order.js': ORDER_SRC,
  'OrderItem.js': ITEM_SRC,
  'OrderBilling.js': BILLING_SRC,
};
const fakeRead = (file) => {
  // Split on both separators: buildSdkTree uses path.join, which emits "\" on Windows.
  const base = file.split(/[\\/]/).pop();
  if (!(base in FAKE_FILES)) throw new Error('no such file');
  return FAKE_FILES[base];
};

test('buildSdkTree flags a model whose source file cannot be read', () => {
  // A referenced model that is missing from the installed SDK must surface as missingModel
  // rather than silently producing an empty field tree, which would read as "no drift".
  const tree = buildSdkTree({ modelName: 'NotAModel', modelsDir: '/models', readFile: fakeRead });

  assert.equal(tree.missingModel, true);
  assert.deepEqual(tree.children, {}, 'no fields invented for a model we could not read');
});

test('parseSdkModelFields captures convertToType AND constructFromObject patterns', () => {
  const fields = parseSdkModelFields(ORDER_SRC);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.order_id.kind, SCALAR);
  assert.equal(byName.exchange_rate.kind, SCALAR);
  assert.deepEqual({ k: byName.items.kind, m: byName.items.model }, { k: MODEL_ARRAY, m: 'OrderItem' });
  assert.equal(byName.cc_emails.kind, PRIMITIVE_ARRAY);
  // constructFromObject -> nested model (this is the pattern the first parser version missed)
  assert.deepEqual({ k: byName.billing.kind, m: byName.billing.model }, { k: MODEL, m: 'OrderBilling' });
});

test('classifySdkType distinguishes scalar / model / modelArray / primitiveArray', () => {
  assert.equal(classifySdkType("'String'").kind, SCALAR);
  assert.equal(classifySdkType('_OrderBilling["default"]').kind, MODEL);
  assert.equal(classifySdkType('[_OrderItem["default"]]').kind, MODEL_ARRAY);
  assert.equal(classifySdkType("['String']").kind, PRIMITIVE_ARRAY);
  assert.equal(classifySdkType("{'String': 'String'}").kind, SCALAR); // maps -> leaf
});

test('buildSdkTree recurses into nested models', () => {
  const tree = buildSdkTree({ modelName: 'Order', modelsDir: '/x', readFile: fakeRead });
  assert.deepEqual(Object.keys(tree.children.billing.children), ['first_name', 'cc_emails']);
  assert.deepEqual(Object.keys(tree.children.items.children), ['merchant_item_id', 'quantity']);
});

test('buildBqTree classifies primitive-array, record, scalar', () => {
  const fields = [
    { name: 'order_id', type: 'STRING', mode: 'NULLABLE' },
    { name: 'cc_emails', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'value', type: 'STRING', mode: 'NULLABLE' }] },
    { name: 'billing', type: 'RECORD', mode: 'NULLABLE', fields: [{ name: 'first_name', type: 'STRING', mode: 'NULLABLE' }] },
    { name: 'items', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'quantity', type: 'INTEGER', mode: 'NULLABLE' }] },
  ];
  const t = buildBqTree(fields);
  assert.equal(t.children.order_id.kind, SCALAR);
  assert.equal(t.children.cc_emails.kind, PRIMITIVE_ARRAY);
  assert.equal(t.children.billing.kind, MODEL);
  assert.equal(t.children.items.kind, MODEL_ARRAY);
});

test('diffTrees reports sdkOnly, bqOnly (with ignore), and shape mismatches', () => {
  const sdk = buildSdkTree({ modelName: 'Order', modelsDir: '/x', readFile: fakeRead });
  const bq = buildBqTree([
    { name: 'order_id', type: 'STRING', mode: 'NULLABLE' },
    { name: 'exchange_rate', type: 'STRING', mode: 'NULLABLE' },
    { name: 'cc_emails', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'value', type: 'STRING' }] },
    // billing present but as a SCALAR -> shape mismatch vs SDK's nested model
    { name: 'billing', type: 'STRING', mode: 'NULLABLE' },
    // items missing entirely -> sdkOnly
    // warehouse-only column -> bqOnly, but ignored by default predicate
    { name: 'email_hash', type: 'STRING', mode: 'NULLABLE' },
    // a genuinely new bq column -> bqOnly reported
    { name: 'surprise_col', type: 'STRING', mode: 'NULLABLE' },
  ]);

  const { sdkOnly, bqOnly, mismatches } = diffTrees(sdk, bq, { ignoreBqOnly: defaultIgnoreBqOnly });
  assert.ok(sdkOnly.includes('items'), 'items missing from BQ -> sdkOnly');
  assert.ok(mismatches.some((m) => m.startsWith('billing')), 'billing scalar-vs-model -> mismatch');
  assert.ok(bqOnly.includes('surprise_col'), 'new bq column -> bqOnly');
  assert.ok(!bqOnly.includes('email_hash'), 'email_hash ignored by default predicate');
});

test('diffTrees descends into nested records and reports dotted paths', () => {
  // The case above stops at the top level because `billing` mismatches on shape. When both
  // sides agree it is a container, the diff must recurse — otherwise drift *inside* a
  // nested record (the shape most of this warehouse's PII lives in) goes unreported.
  const sdk = buildSdkTree({ modelName: 'Order', modelsDir: '/x', readFile: fakeRead });
  const bq = buildBqTree([
    { name: 'order_id', type: 'STRING', mode: 'NULLABLE' },
    { name: 'exchange_rate', type: 'NUMERIC', mode: 'NULLABLE' },
    { name: 'cc_emails', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'value', type: 'STRING' }] },
    {
      name: 'billing',
      type: 'RECORD',
      mode: 'NULLABLE',
      fields: [
        // first_name present in the SDK model but absent here -> nested sdkOnly
        { name: 'cc_emails', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'value', type: 'STRING' }] },
        { name: 'postal_code', type: 'STRING', mode: 'NULLABLE' }, // nested bqOnly
      ],
    },
    {
      name: 'items',
      type: 'RECORD',
      mode: 'REPEATED',
      fields: [
        { name: 'merchant_item_id', type: 'STRING', mode: 'NULLABLE' },
        // quantity present in the SDK but not here, inside a REPEATED record
        { name: 'quantity', type: 'RECORD', mode: 'NULLABLE', fields: [{ name: 'x', type: 'STRING' }] },
      ],
    },
  ]);

  const { sdkOnly, bqOnly, mismatches } = diffTrees(sdk, bq, { ignoreBqOnly: defaultIgnoreBqOnly });

  assert.ok(sdkOnly.includes('billing.first_name'), 'nested missing column -> dotted sdkOnly path');
  assert.ok(bqOnly.includes('billing.postal_code'), 'nested new column -> dotted bqOnly path');
  assert.ok(
    mismatches.some((m) => m.startsWith('items.quantity')),
    'shape mismatch inside a repeated record -> dotted mismatch path',
  );
  assert.ok(!sdkOnly.includes('billing'), 'billing itself aligns; only its children drift');
});

test('defaultIgnoreBqOnly ignores hashes and partition/bookkeeping columns', () => {
  assert.equal(defaultIgnoreBqOnly('billing.email_hash', 'email_hash'), true);
  assert.equal(defaultIgnoreBqOnly('cc_emails_hashes', 'cc_emails_hashes'), true);
  assert.equal(defaultIgnoreBqOnly('partition_oid', 'partition_oid'), true);
  assert.equal(defaultIgnoreBqOnly('RecordTime', 'RecordTime'), true);
  assert.equal(defaultIgnoreBqOnly('first_name', 'first_name'), false);
});

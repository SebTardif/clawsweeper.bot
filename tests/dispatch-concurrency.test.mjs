import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync(new URL('../.github/workflows/clawsweeper-dispatch.yml', import.meta.url), 'utf8');
const groupTemplate = workflow.match(/^  group: (.+)$/m)?.[1];
const cancelExpression = workflow.match(/^  cancel-in-progress: \$\{\{ (.+) \}\}$/m)?.[1];
assert.ok(groupTemplate, 'workflow concurrency group must exist');
assert.ok(cancelExpression, 'workflow cancellation policy must exist');

function event(name, action, { item = 42, comment = 100, actor = 'maintainer' } = {}) {
  return {
    repository: 'example/project',
    event_name: name,
    actor,
    run_id: 999,
    event: {
      action,
      issue: name === 'pull_request_target' ? {} : { number: item },
      pull_request: name === 'pull_request_target' ? { number: item } : {},
      comment: name === 'issue_comment' ? { id: comment } : {},
    },
  };
}

function evaluate(expression, github) {
  return runInNewContext(expression, {
    github,
    endsWith: (value, suffix) => value.toLowerCase().endsWith(suffix.toLowerCase()),
  }, { timeout: 1000 });
}

function group(github) {
  return groupTemplate.replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => evaluate(expression, github));
}

for (const name of ['issues', 'pull_request_target']) {
  test(`a ${name} edit cannot cancel a comment command`, () => {
    assert.notEqual(group(event(name, 'edited')), group(event('issue_comment', 'created')));
  });

  test(`${name} edits still supersede earlier metadata events`, () => {
    assert.equal(group(event(name, 'opened')), group(event(name, 'edited')));
    assert.equal(evaluate(cancelExpression, event(name, 'edited')), true);
  });

  test(`ignored bot ${name} labels cannot displace human events`, () => {
    assert.notEqual(group(event(name, 'labeled', { actor: 'robot[bot]' })), group(event(name, 'edited')));
  });
}

test('separate comment commands do not displace each other', () => {
  assert.notEqual(group(event('issue_comment', 'created')), group(event('issue_comment', 'edited', { comment: 101 })));
});

test('editing the same comment supersedes its earlier dispatch', () => {
  assert.equal(group(event('issue_comment', 'created')), group(event('issue_comment', 'edited')));
  assert.equal(evaluate(cancelExpression, event('issue_comment', 'edited')), true);
});

test('synchronize and ready_for_review supersede metadata for the same PR', () => {
  for (const action of ['synchronize', 'ready_for_review']) {
    assert.equal(group(event('pull_request_target', action)), group(event('pull_request_target', 'opened')));
    assert.equal(evaluate(cancelExpression, event('pull_request_target', action)), true);
  }
});

test('new comments and labels do not cancel running dispatches', () => {
  for (const [name, action] of [['issue_comment', 'created'], ['issues', 'labeled'], ['pull_request_target', 'unlabeled']]) {
    assert.equal(evaluate(cancelExpression, event(name, action)), false);
  }
});

test('different items and repositories have separate groups', () => {
  const first = event('issues', 'edited');
  const otherRepo = { ...first, repository: 'example/other' };
  assert.notEqual(group(first), group(event('issues', 'edited', { item: 43 })));
  assert.notEqual(group(first), group(otherRepo));
});

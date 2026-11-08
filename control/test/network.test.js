// Unit tests for the sandbox-network filter used by both HTTP servers.
// Importing server.js would start the servers, so the pure helper lives in net.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInSubnet } from '../src/net.js';

test('requests from the sandbox subnet are recognised, others are not', () => {
  assert.equal(isInSubnet('172.19.0.5', '172.19.0.0/16'), true);
  assert.equal(isInSubnet('::ffff:172.19.3.7', '172.19.0.0/16'), true);
  assert.equal(isInSubnet('172.20.0.5', '172.19.0.0/16'), false);
  assert.equal(isInSubnet('10.0.0.1', '10.0.0.0/8'), true);
  assert.equal(isInSubnet('192.168.1.10', '192.168.1.0/24'), true);
  assert.equal(isInSubnet('192.168.2.10', '192.168.1.0/24'), false);
});

test('unknown subnet or non-IPv4 addresses never match', () => {
  assert.equal(isInSubnet('172.19.0.5', null), false);
  assert.equal(isInSubnet(undefined, '172.19.0.0/16'), false);
  assert.equal(isInSubnet('::1', '172.19.0.0/16'), false);
});

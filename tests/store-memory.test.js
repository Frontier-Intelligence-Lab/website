import { test } from 'node:test';
import { createMemoryStore } from '../src/store/memory.js';
import { runStoreContract } from './store-contract.js';

runStoreContract(test, async () => createMemoryStore(), 'memory store');

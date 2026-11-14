import type { EntityManager } from 'typeorm';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface LedgerEvent {
  contract: string;
  name: string;
  args: Record<string, string>;
  blockNumber: number;
}

/**
 * Applies one chain event to the internal ledger (`holdings`, `token_state`).
 *
 * The ledger is a pure function of the event stream: the same events in the same order
 * always produce the same rows. That is what makes a rebuild from `chain_events` possible.
 */
export async function applyEvent(manager: EntityManager, event: LedgerEvent): Promise<void> {
  if (event.contract !== 'SecurityToken') return;
  const { args, blockNumber } = event;

  switch (event.name) {
    case 'Transfer': {
      if (args.from !== ZERO) await addBalance(manager, args.from, `-${args.value}`, blockNumber);
      if (args.to !== ZERO) await addBalance(manager, args.to, args.value, blockNumber);
      if (args.from === ZERO) await addSupply(manager, args.value, blockNumber);
      if (args.to === ZERO) await addSupply(manager, `-${args.value}`, blockNumber);
      break;
    }
    case 'TokensFrozen':
      await addFrozen(manager, args.account, args.amount, blockNumber);
      break;
    case 'TokensUnfrozen':
      await addFrozen(manager, args.account, `-${args.amount}`, blockNumber);
      break;
    case 'AddressFrozen':
      await setAddressFrozen(manager, args.account, args.frozen === 'true', blockNumber);
      break;
    case 'RecoverySuccess': {
      // The contract moves the frozen amount and the frozen flag along with the balance
      // without separate events, so the ledger mirrors that here. The balance itself
      // arrives as a Transfer event.
      const [lost] = await manager.query<{ frozen: string; address_frozen: boolean }[]>(
        'SELECT frozen, address_frozen FROM holdings WHERE wallet = $1',
        [args.lostWallet],
      );
      if (lost) {
        if (lost.frozen !== '0') {
          await addFrozen(manager, args.lostWallet, `-${lost.frozen}`, blockNumber);
          await addFrozen(manager, args.newWallet, lost.frozen, blockNumber);
        }
        if (lost.address_frozen) {
          await setAddressFrozen(manager, args.lostWallet, false, blockNumber);
          await setAddressFrozen(manager, args.newWallet, true, blockNumber);
        }
      }
      break;
    }
    case 'RegisteredSupplySet':
      await manager.query('UPDATE token_state SET registered_supply = $1, updated_block = $2 WHERE id = 1', [
        args.current,
        blockNumber,
      ]);
      break;
    case 'PauseStateChanged':
      await manager.query('UPDATE token_state SET paused = $1, updated_block = $2 WHERE id = 1', [
        args.paused === 'true',
        blockNumber,
      ]);
      break;
    default:
      break;
  }
}

async function addBalance(manager: EntityManager, wallet: string, delta: string, block: number): Promise<void> {
  await manager.query(
    `INSERT INTO holdings (wallet, balance, updated_block) VALUES ($1, $2::numeric, $3)
     ON CONFLICT (wallet) DO UPDATE SET balance = holdings.balance + $2::numeric, updated_block = $3`,
    [wallet, delta, block],
  );
}

async function addFrozen(manager: EntityManager, wallet: string, delta: string, block: number): Promise<void> {
  await manager.query(
    `INSERT INTO holdings (wallet, frozen, updated_block) VALUES ($1, $2::numeric, $3)
     ON CONFLICT (wallet) DO UPDATE SET frozen = holdings.frozen + $2::numeric, updated_block = $3`,
    [wallet, delta, block],
  );
}

async function setAddressFrozen(manager: EntityManager, wallet: string, frozen: boolean, block: number): Promise<void> {
  await manager.query(
    `INSERT INTO holdings (wallet, address_frozen, updated_block) VALUES ($1, $2, $3)
     ON CONFLICT (wallet) DO UPDATE SET address_frozen = $2, updated_block = $3`,
    [wallet, frozen, block],
  );
}

async function addSupply(manager: EntityManager, delta: string, block: number): Promise<void> {
  await manager.query(
    'UPDATE token_state SET total_supply = total_supply + $1::numeric, updated_block = $2 WHERE id = 1',
    [delta, block],
  );
}

/** Empties the ledger so it can be replayed from the stored events. */
export async function resetLedger(manager: EntityManager): Promise<void> {
  await manager.query('TRUNCATE holdings');
  await manager.query(
    'UPDATE token_state SET total_supply = 0, registered_supply = 0, paused = false, updated_block = 0 WHERE id = 1',
  );
}

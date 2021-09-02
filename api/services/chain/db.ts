import Dexie from "dexie"

import {
  AccountBalance,
  AccountNetwork,
  AnyEVMTransaction,
  EIP1559Block,
  FungibleAsset,
  Network,
  UNIXTime,
} from "../../types"

type Transaction = AnyEVMTransaction & {
  dataSource: "alchemy" | "local"
  firstSeen: UNIXTime
}

interface Migration {
  id: number
  appliedAt: number
}

// TODO keep track of blocks invalidated by a reorg
// TODO keep track of transaction replacement / nonce invalidation

export class ChainDatabase extends Dexie {
  /*
   * Accounts whose transaction and balances should be tracked on a particular
   * network.
   *
   * Keyed by the [account, network name, network chain ID] triplet. Note that
   * "account" in this context refers to e.g. an Ethereum address.
   */
  accountsToTrack: Dexie.Table<AccountNetwork, [string, string, string]>

  /*
   * Partial block headers cached to track reorgs and network status.
   *
   * Keyed by the [block hash, network name] pair.
   */
  blocks: Dexie.Table<EIP1559Block, [string, string]>

  /*
   * Historic and pending chain transactions relevant to tracked accounts.
   * chainTransaction is used in this context to distinguish from database
   * transactions.
   *
   * Keyed by the [transaction hash, network name] pair.
   */
  chainTransactions: Dexie.Table<Transaction, [string, string]>

  /*
   * Historic account balances.
   */
  balances: Dexie.Table<AccountBalance, number>

  migrations: Dexie.Table<Migration, number>

  constructor() {
    super("tally/chain")
    this.version(1).stores({
      migrations: "++id,appliedAt",
      accountsToTrack:
        "&[account+network.name+network.chainID],account,network.family,network.chainID,network.name",
      balances:
        "++id,account,assetAmount.amount,assetAmount.asset.symbol,network.name,blockHeight,retrievedAt",
      chainTransactions:
        "&[hash+network.name],hash,from,[from+network.name],to,[to+network.name],nonce,[nonce+from+network.name],blockHash,blockNumber,network.name,firstSeen,dataSource",
      blocks:
        "&[hash+network.name],[network.name+timestamp],hash,network.name,timestamp,parentHash,blockHeight,[blockHeight+network.name]",
    })

    this.chainTransactions.hook(
      "updating",
      (modifications, _, chainTransaction) => {
        // Only these properties can be updated on a stored transaction.
        // NOTE: Currently we do NOT throw if another property modification is
        // attempted; instead, we just ignore it.
        const allowedVariants = ["blockHeight", "blockHash", "firstSeen"]

        const filteredModifications = Object.fromEntries(
          Object.entries(modifications).filter(([k]) =>
            allowedVariants.includes(k)
          )
        )

        // If there is an attempt to modify `firstSeen`, prefer the earliest
        // first seen value between the update and the existing value.
        if ("firstSeen" in filteredModifications) {
          return {
            ...filteredModifications,
            firstSeen: Math.min(
              chainTransaction.firstSeen,
              filteredModifications.firstSeen
            ),
          }
        }

        return filteredModifications
      }
    )
  }

  async getLatestBlock(network: Network): Promise<EIP1559Block> {
    return this.blocks
      .where("[network.name+timestamp]")
      .above([network.name, Date.now() - 60 * 60 * 24])
      .reverse()
      .sortBy("timestamp")[0]
  }

  async getTransaction(
    network: Network,
    txHash: string
  ): Promise<AnyEVMTransaction | null> {
    return (
      (
        await this.chainTransactions
          .where("[hash+network.name]")
          .equals([txHash, network.name])
          .toArray()
      )[0] || null
    )
  }

  async addOrUpdateTransaction(
    tx: AnyEVMTransaction,
    dataSource: Transaction["dataSource"]
  ): Promise<void> {
    await this.transaction("rw", this.chainTransactions, () => {
      return this.chainTransactions.put({
        ...tx,
        firstSeen: Date.now(),
        dataSource,
      })
    })
  }

  async getLatestAccountBalance(
    account: string,
    network: Network,
    asset: FungibleAsset
  ): Promise<AccountBalance | null> {
    // TODO this needs to be tightened up, both for performance and specificity
    const balanceCandidates = await this.balances
      .where("retrievedAt")
      .above(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .filter(
        (balance) =>
          balance.account === account &&
          balance.assetAmount.asset.symbol === asset.symbol &&
          balance.network.name === network.name
      )
      .reverse()
      .sortBy("retrievedAt")
    return balanceCandidates.length > 0 ? balanceCandidates[0] : null
  }

  async setAccountsToTrack(
    accountAndNetworks: AccountNetwork[]
  ): Promise<void> {
    await this.transaction("rw", this.accountsToTrack, () => {
      this.accountsToTrack.clear()
      this.accountsToTrack.bulkAdd(accountAndNetworks)
    })
  }

  async getAccountsToTrack(): Promise<AccountNetwork[]> {
    return this.accountsToTrack.toArray()
  }
}

export async function getDB(): Promise<ChainDatabase> {
  return new ChainDatabase()
}

export async function getOrCreateDB(): Promise<ChainDatabase> {
  const db = await getDB()
  const numMigrations = await db.migrations.count()
  if (numMigrations === 0) {
    await db.transaction("rw", db.migrations, async () => {
      db.migrations.add({ id: 0, appliedAt: Date.now() })
      // TODO decide migrations before the initial release
    })
  }
  return db
}

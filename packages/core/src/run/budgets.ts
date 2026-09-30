/**
 * What is left of the two allowances a pull request has.
 *
 * They are separate on purpose, and the reason is the whole point of counting
 * them at all. A reviewer disagreeing and a check going red are different kinds
 * of wrong: one is a person asking for something else, the other is the change
 * not working. A single pool for both means a pull request that survived two
 * flaky mornings has nothing left for the first thing a person actually asks
 * for, and gets abandoned while being correct.
 */

export interface Spent {
  readonly ciFixes: number
  readonly revisions: number
}

export interface Allowance {
  readonly maxCiFixes: number
  readonly maxRevisions: number
}

/** Whether another attempt at a failing check is allowed. */
export function mayFixCi(spent: Spent, allowance: Allowance): boolean {
  return spent.ciFixes < allowance.maxCiFixes
}

/** Whether another go at what a reviewer asked for is allowed. */
export function mayRevise(spent: Spent, allowance: Allowance): boolean {
  return spent.revisions < allowance.maxRevisions
}

/**
 * What to tell a person when something stops, in their terms.
 *
 * A pull request that stopped is going to sit there, so the last thing said
 * about it has to explain itself without anybody reading a state name.
 */
export function exhaustedBecause(
  spent: Spent,
  allowance: Allowance,
): string | undefined {
  if (!mayFixCi(spent, allowance) && spent.ciFixes > 0) {
    return `the checks were fixed ${spent.ciFixes} times and are still failing`
  }
  if (!mayRevise(spent, allowance) && spent.revisions > 0) {
    return `this was revised ${spent.revisions} times and is still not right`
  }
  return undefined
}

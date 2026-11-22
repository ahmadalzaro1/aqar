import type { Metadata } from 'next';
import './site.css';

export const metadata: Metadata = {
  title: 'Aqar \u2014 the property operations ledger',
  description:
    'Aqar is an open-source, self-hostable property operations ledger with an agentic maintenance layer, built for Jordan and the wider MENA market. Money is deterministic, life safety is a hard code branch, every action is attributed and reversible.',
};

/**
 * The public site, designed by a model against a written brief and then
 * integrated here: the page is a document, the console is the application.
 * Rendered LTR inside the locale-aware shell, because this page is English
 * while `/dashboard` follows the console locale.
 */
export default function Home() {
  return (
    <div className="site" lang="en" dir="ltr">
      <a className="skip" href="#main">
        Skip to content
      </a>

      <main id="main">
        <section className="hero" aria-label="Introduction">
          <div className="wrap">
            <h1>
              Aqar{' '}
              <span className="ar-name" lang="ar" dir="rtl">
                عقار
              </span>
            </h1>
            <p className="lede">
              An open-source, self-hostable property operations ledger with an agentic maintenance
              layer — built for the person who runs buildings in Amman and the wider MENA market.
              The owner-operator or management company with 50–2,000 units, keeping the money in
              spreadsheets and the maintenance in WhatsApp.
            </p>
            <p className="modules">
              <span className="label">Nine modules, one money-and-obligation ledger:</span>{' '}
              properties · units · tenants and leases · charges and receipts · tickets and work
              orders · vendor dispatch · bank reconciliation · owner statements · a plan library.
            </p>
            <p className="actions">
              <a className="btn btn--primary" href="#money">
                Read the ledger
              </a>
              <a className="btn btn--quiet" href="https://github.com/ahmadalzaro1/aqar">
                Source on GitHub
              </a>
            </p>
            <p className="meta-line">
              Open source · MIT licence · Self-hosted · English page, Arabic-first console
            </p>
          </div>
        </section>

        <section id="money">
          <div className="wrap">
            <h2>
              <span className="law-no">Law 1</span> Money is deterministic.
            </h2>
            <p>
              One Jordanian dinar is 1,000 fils. All money arithmetic in Aqar is pure integer fils
              inside one library. No floats, no rounding on the way in, and no model anywhere near a
              number. JOD always renders with three decimals.
            </p>

            <figure className="ledger">
              <figcaption>Al-Weibdeh Heritage Building · period 2026-11 · JOD</figcaption>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Unit</th>
                    <th scope="col">Period</th>
                    <th scope="col">Charge</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      R-101<span className="tenant">Flat 101</span>
                    </td>
                    <td className="period">2026-11</td>
                    <td>Rent</td>
                    <td className="num">
                      <span className="amt">
                        350<span className="fils">.000</span>
                      </span>
                    </td>
                    <td className="state">received</td>
                  </tr>
                  <tr>
                    <td>
                      R-102<span className="tenant">Flat 102</span>
                    </td>
                    <td className="period">2026-11</td>
                    <td>Rent</td>
                    <td className="num">
                      <span className="amt">
                        260<span className="fils">.000</span>
                      </span>
                    </td>
                    <td className="state">received</td>
                  </tr>
                  <tr className="owed">
                    <td>
                      R-103<span className="tenant">Flat 103</span>
                    </td>
                    <td className="period">2026-11</td>
                    <td>Rent</td>
                    <td className="num">
                      <span className="amt">
                        180<span className="fils">.000</span>
                      </span>
                    </td>
                    <td className="state">overdue</td>
                  </tr>
                  <tr>
                    <td>
                      R-104<span className="tenant">Flat 104</span>
                    </td>
                    <td className="period">2026-11</td>
                    <td>Service fee</td>
                    <td className="num">
                      <span className="amt">
                        12<span className="fils">.500</span>
                      </span>
                    </td>
                    <td className="state">due</td>
                  </tr>
                  <tr>
                    <td>
                      R-101<span className="tenant">Flat 101</span>
                    </td>
                    <td className="period">2026-11</td>
                    <td>Deposit</td>
                    <td className="num">
                      <span className="amt">
                        350<span className="fils">.000</span>
                      </span>
                    </td>
                    <td className="state">held</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="total-label">
                      Total
                    </td>
                    <td className="num">
                      <span className="amt total">
                        1,152<span className="fils">.500</span>
                      </span>
                    </td>
                    <td className="state">JOD</td>
                  </tr>
                </tfoot>
              </table>
              <p className="ledger-footer">5 obligations · 1 overdue · 1 held as a liability</p>
            </figure>

            <p>
              The console is bilingual: Arabic-first, right-to-left, one click to English — JOD with
              three decimals in both.
            </p>
          </div>
        </section>

        <section id="safety">
          <div className="wrap">
            <h2>
              <span className="law-no">Law 2</span> Life safety is a hard code branch.
            </h2>
            <p>
              A deterministic multilingual pre-check runs before any model. A model may raise an
              emergency, never lower it. An emergency takes the fast path, pages a human, prints
              safety instructions, and is never folded into a digest.
            </p>

            <h3>The branch, as it ran</h3>
            <dl className="record">
              <div className="row">
                <dt>Ticket</dt>
                <dd>T-2291 · Al-Weibdeh Heritage Building</dd>
              </div>
              <div className="row">
                <dt>Reported</dt>
                <dd>
                  <span className="ar-report" lang="ar" dir="rtl">
                    ريحة غاز قوية في المطبخ
                  </span>
                  <span className="en-report">Strong gas smell in the kitchen</span>
                </dd>
              </div>
              <div className="row">
                <dt>Channel</dt>
                <dd>WhatsApp</dd>
              </div>
              <div className="row">
                <dt>Severity</dt>
                <dd>
                  <span className="live">emergency</span>
                </dd>
              </div>
              <div className="row">
                <dt>Agent</dt>
                <dd>Raised by the deterministic pre-check, confirmed by the model</dd>
              </div>
              <div className="row">
                <dt>Human</dt>
                <dd>Paged 00:14, acknowledged 00:19</dd>
              </div>
              <div className="row">
                <dt>Actions</dt>
                <dd>
                  <ul className="plain">
                    <li>Gas valve shut-off instructions sent in Arabic</li>
                    <li>
                      <span className="live">Licensed plumber dispatched</span>
                    </li>
                  </ul>
                </dd>
              </div>
            </dl>

            <p>
              The emergency classifier is measured, not asserted: recall 1.0000 and false positives
              0.00%, on the deterministic lane and the local-model lane. An Arabic gas-leak ticket
              keeps its emergency flag even when the model under-calls it.
            </p>
          </div>
        </section>

        <section id="approval">
          <div className="wrap">
            <h2>
              <span className="law-no">Law 3</span> Agents draft. People approve.
            </h2>
            <p>
              The agent layer is typed. Anything that moves money, binds a contract, or dispatches a
              vendor above a limit waits for a person. The default mode is
              <code>dry_run</code> — a proposal that cannot post.
            </p>
            <p>
              Every action is attributed and reversible. The audit is append-only: nothing is
              hard-deleted, and a correction is a reversal.
            </p>

            <details className="audit">
              <summary>What every audit row holds</summary>
              <ul className="plain ruled">
                <li>Actor</li>
                <li>Time</li>
                <li>Before / after</li>
                <li>Model id</li>
                <li>Prompt version</li>
                <li>Confidence</li>
                <li>Tool trace</li>
              </ul>
            </details>

            <p>
              An MCP server exposes 18 tools, so an outside agent (Hermes) can read the ledger and
              propose work. Ask it to pay an invoice and it returns:
              <code>requires human approval</code>.
            </p>
          </div>
        </section>

        <section id="drawings">
          <div className="wrap">
            <h2>Drawings become rooms and units.</h2>
            <p>
              DXF and vector PDF in, rooms out, areas reconciled against the stated total. The
              pipeline is ruled like the ledger it feeds:
            </p>
            <ol className="pipeline">
              <li>
                <span className="step-no">01</span>
                <span>A drawing that came from a file is arithmetic.</span>
              </li>
              <li>
                <span className="step-no">02</span>
                <span>
                  One that came from pixels is a suggestion — with a confidence the database refuses
                  without.
                </span>
              </li>
              <li>
                <span className="step-no">03</span>
                <span>Areas are reconciled against the stated total.</span>
              </li>
              <li>
                <span className="step-no">04</span>
                <span>
                  A parsed area never writes a unit’s area. Only an approved proposal does.
                </span>
              </li>
            </ol>
          </div>
        </section>

        <section id="hosting">
          <div className="wrap">
            <h2>It runs on your own machine.</h2>
            <p>
              Self-hosted: Postgres with pgvector, Redis, and Docker Compose. The ledger, the
              agents, and the audit live where you put them.
            </p>

            <h3>The schema as built</h3>
            <dl className="stats">
              <div className="stat">
                <dt>Tables</dt>
                <dd>84</dd>
              </div>
              <div className="stat">
                <dt>Foreign keys</dt>
                <dd>184</dd>
              </div>
              <div className="stat">
                <dt>CHECK constraints</dt>
                <dd>129</dd>
              </div>
            </dl>
            <p>The database refuses an ontology violation rather than trusting the app.</p>
          </div>
        </section>

        <section id="source">
          <div className="wrap">
            <h2>Open source. MIT licence.</h2>
            <p>Read it, fork it, run it. The source is the product.</p>
            <p className="actions">
              <a className="btn" href="https://github.com/ahmadalzaro1/aqar">
                github.com/ahmadalzaro1/aqar
              </a>
              <a className="btn" href="mailto:hello@aqar.example">
                Write to the maintainers
              </a>
            </p>
            <p className="meta-line">
              Interface measurement: 0 overflow offenders across 5 pages × 4 widths × 2 locales.
            </p>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <p className="colophon">
            Aqar{' '}
            <span lang="ar" dir="rtl">
              عقار
            </span>{' '}
            · property operations ledger · MIT ·
            <a href="https://github.com/ahmadalzaro1/aqar">github.com/ahmadalzaro1/aqar</a> ·
            <a href="mailto:hello@aqar.example">hello@aqar.example</a>
          </p>
        </div>
      </footer>
    </div>
  );
}

import { Link } from 'react-router-dom';
import { useAppState, fmtPrice } from '../hooks';

export default function Shows() {
  const { state, error } = useAppState();
  if (error) return <div className="banner error">服务不可用：{error}</div>;
  if (!state) return <div className="loading">加载中…</div>;

  return (
    <div>
      <h1>演出场次</h1>
      <div className="show-grid">
        {state.shows.map((show) => {
          const seats = state.seats.filter((s) => s.showId === show.id);
          const tiers = [...new Set(seats.map((s) => s.tier))];
          return (
            <Link key={show.id} to={`/shows/${show.id}`} className="show-card" data-testid={`show-${show.id}`}>
              <h2>{show.name}</h2>
              <p className="muted">{show.venue} · {show.startsAt}</p>
              <ul className="tier-summary">
                {tiers.map((tier) => {
                  const ts = seats.filter((s) => s.tier === tier);
                  const left = ts.filter((s) => s.status === 'available').length;
                  return (
                    <li key={tier} data-testid={`remaining-${show.id}-${tier}`}>
                      <span className={`tier-dot tier-${tier}`} />
                      {tier} {fmtPrice(ts[0].price)} — 余票 <b>{left}</b>/{ts.length}
                    </li>
                  );
                })}
              </ul>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

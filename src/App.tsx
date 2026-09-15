import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import Shows from './pages/Shows';
import ShowDetail from './pages/ShowDetail';
import Orders from './pages/Orders';
import Admin from './pages/Admin';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🎫 票务锁座与分账台</div>
        <nav>
          <NavLink to="/shows">场次购票</NavLink>
          <NavLink to="/orders">我的订单</NavLink>
          <NavLink to="/admin">工作人员台</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/shows" replace />} />
          <Route path="/shows" element={<Shows />} />
          <Route path="/shows/:showId" element={<ShowDetail />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </main>
    </div>
  );
}

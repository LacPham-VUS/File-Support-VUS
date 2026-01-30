import React, { useState } from 'react';
import { AUTH_STORAGE_KEY, VALID_PASSWORD, VALID_USERNAME } from '../const/appConstants';

interface LoginProps {
  onAuthenticated: () => void;
}

const Login: React.FC<LoginProps> = ({ onAuthenticated }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const isValid = username === VALID_USERNAME && password === VALID_PASSWORD;
    if (!isValid) {
      setError('Sai tài khoản hoặc mật khẩu.');
      return;
    }

    window.localStorage.setItem(AUTH_STORAGE_KEY, '1');
    setError('');
    onAuthenticated();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-emerald-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-xl">
        <h1 className="text-2xl font-bold text-slate-800">Đăng nhập</h1>
        <p className="mt-1 text-sm text-slate-600">Vui lòng đăng nhập để tiếp tục xử lý PDF.</p>
        <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
            Tên đăng nhập
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Nhập tên đăng nhập"
              autoComplete="username"
              required
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-base font-normal text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-semibold text-slate-700">
            Mật khẩu
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Nhập mật khẩu"
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-base font-normal text-slate-800 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
            />
          </label>
          {error && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-white font-semibold shadow hover:bg-emerald-700"
          >
            Đăng nhập
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;

# 🏟️ Active Arena – Sports Club Management System (Server)

**Mi-12 Assignment 12 | Assignment12_category_023**

This is the **backend server** of the **Active Arena** — a full-featured **Sports Club Management System (SCMS)**. It supports JWT-based authentication, user role verification, Stripe payments, booking logic, and full admin-member-user workflows.

🔗 **Live Server:** [https://active-arena.vercel.app](https://active-arena.vercel.app)  
🔐 Protected by **JWT Authentication**

---

## 📌 Key Backend Features

- ✅ **JWT Authentication** system (login/signup)
- 👤 Role-based access control: `admin`, `member`, `user`
- 🧾 **Stripe Payment Integration** with support for coupons
- 🏸 **Court Booking APIs** with time slot & session management
- 📊 **Payment & Booking History APIs**
- 🧠 User and Role management for Admin Panel
- 📣 Announcement endpoints for dynamic dashboard updates
- 🍪 Secure cookie handling via `cookie-parser`
- 🌍 Full **CORS** support for frontend integration
- 📦 Uses **MongoDB** as the primary database

---

## 🛠 Tech Stack

### 🔧 Backend

- **Node.js** + **Express.js**
- **MongoDB** (native driver)
- **JWT** for secure token-based authentication
- **Stripe API** for online payments
- **dotenv** for environment variable management
- **cookie-parser** for secure cookies
- **bcrypt** for password hashing
- **nodemon** for development

---

## 📁 Folder Structure

```
📦 server/
├── index.js          # Main server entry
├── .env              # Environment variables
├── /routes           # All route handlers (optional)
├── /controllers      # Business logic (optional)
├── /middlewares      # Auth, role check, etc.
└── /utils            # Helper functions (optional)
```

---

## ⚙️ Environment Setup

Create a `.env` file in the root directory:

```env
PORT=5000
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.mongodb.net/active-arena
JWT_SECRET=your_jwt_secret
STRIPE_SECRET_KEY=your_stripe_secret_key
```

---

## 🧪 Run Locally

### 1. Clone the project

```bash
git clone https://github.com/hasancodex/active-arena-server.git
cd active-arena-server
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start development server

```bash
npm run dev
```

---

## 📡 API Endpoints Overview

| Method | Endpoint                | Description                        | Protected |
|--------|-------------------------|------------------------------------|-----------|
| POST   | `/jwt`                  | Generate JWT token                 | ❌        |
| GET    | `/users`                | Get all users                      | ✅ Admin  |
| PATCH  | `/users/member/:id`     | Approve user as member             | ✅ Admin  |
| POST   | `/create-payment-intent`| Stripe payment intent              | ✅ User   |
| POST   | `/bookings`             | Create a booking                   | ✅ Member |
| GET    | `/bookings?email=`      | Get user bookings                  | ✅ User   |
| POST   | `/coupons`              | Create discount coupon             | ✅ Admin  |
| GET    | `/announcements`        | Get announcements for dashboard    | ❌        |

---

## 🔐 Security

- JWT token is used for authentication and must be included in the `Authorization` header.
- CORS is enabled for frontend access.
- Sensitive keys are stored in `.env` (do not commit this file).

---

## 📦 Deployment

This server can be deployed to:

- [x] **Vercel**
- [x] **Render**
- [x] **Railway**
- [x] **Cyclic**

Make sure to set all `.env` values in the environment dashboard of your deployment platform.

---

## 👨‍💻 Author

- [Mehedi Hasan](https://github.com/hasancodex)

---


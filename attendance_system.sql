-- ============================================================
-- Attendance and Event Management System
-- MySQL database schema (for use with XAMPP / phpMyAdmin)
-- ============================================================

CREATE DATABASE IF NOT EXISTS attendance_system
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE attendance_system;

-- ------------------------------------------------------------
-- Students
-- ------------------------------------------------------------
CREATE TABLE students (
  id            VARCHAR(50)  PRIMARY KEY,        -- e.g. stu_1732012345678
  student_id    VARCHAR(50)  NOT NULL UNIQUE,     -- school-issued ID, used in barcodes/QR
  name          VARCHAR(150) NOT NULL,
  department    VARCHAR(100),
  email         VARCHAR(150),
  contact       VARCHAR(50),
  year_level    VARCHAR(20),
  course        VARCHAR(100),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Admin account (single admin, matches ap_admin_creds)
-- ------------------------------------------------------------
CREATE TABLE admin_credentials (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  username   VARCHAR(50) NOT NULL UNIQUE,
  pass_hash  VARCHAR(255) NOT NULL                -- SHA-256 hash, same as app's sha256()
) ENGINE=InnoDB;

-- Default admin: username "admin", password "Admin@123"
-- (this matches the app's original built-in default — change it after first login!)
INSERT INTO admin_credentials (username, pass_hash) VALUES
('admin', 'e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7');

-- ------------------------------------------------------------
-- Events
-- ------------------------------------------------------------
CREATE TABLE events (
  id                 VARCHAR(50)  PRIMARY KEY,   -- e.g. ev_1732012345678
  name               VARCHAR(150) NOT NULL,
  event_date         DATE NOT NULL,
  open_time          TIME,
  on_time_deadline   TIME,
  late_deadline      TIME,
  fine_amount        DECIMAL(10,2) DEFAULT 0,
  late_fine_amount   DECIMAL(10,2) DEFAULT 0,
  checkout_enabled   TINYINT(1) DEFAULT 0,
  checkout_open      TIME,
  checkout_close     TIME
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Attendance records (check-ins)
-- ------------------------------------------------------------
CREATE TABLE attendance_records (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  student_id       VARCHAR(50) NOT NULL,
  event_id         VARCHAR(50) NOT NULL,
  status           ENUM('present','late','absent') NOT NULL,
  barcode_checkin  TINYINT(1) DEFAULT 0,
  qr_checkin       TINYINT(1) DEFAULT 0,
  appealed         TINYINT(1) DEFAULT 0,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_student_event (student_id, event_id),
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id)   REFERENCES events(id)            ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Checkouts (time-out records)
-- ------------------------------------------------------------
CREATE TABLE checkouts (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  student_id      VARCHAR(50) NOT NULL,
  event_id        VARCHAR(50) NOT NULL,
  checkout_time   DATETIME,
  admin_checkout  TINYINT(1) DEFAULT 0,
  UNIQUE KEY uniq_student_event (student_id, event_id),
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id)   REFERENCES events(id)            ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Photos (selfies captured on check-in / check-out)
-- Stored as base64 data URLs, same as the app's localStorage format
-- ------------------------------------------------------------
CREATE TABLE photos (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  student_id   VARCHAR(50) NOT NULL,
  event_id     VARCHAR(50) NOT NULL,
  photo_type   ENUM('checkin','checkout') DEFAULT 'checkin',
  photo_data   LONGTEXT,                          -- base64 data URL
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_student_event_type (student_id, event_id, photo_type),
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id)   REFERENCES events(id)            ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Fines
-- ------------------------------------------------------------
CREATE TABLE fines (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  student_id   VARCHAR(50) NOT NULL,
  event_id     VARCHAR(50) NOT NULL,
  amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  fine_type    ENUM('absence','late') NOT NULL,
  status       ENUM('unpaid','paid','waived') DEFAULT 'unpaid',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_student_event_type (student_id, event_id, fine_type),
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id)   REFERENCES events(id)            ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Appeals
-- ------------------------------------------------------------
CREATE TABLE appeals (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  student_id          VARCHAR(50) NOT NULL,
  event_id            VARCHAR(50) NOT NULL,
  appeal_type         VARCHAR(20),
  reason              TEXT,
  evidence            LONGTEXT,                    -- base64 data URL of uploaded evidence, optional
  evidence_file_name  VARCHAR(255),
  status              ENUM('pending','approved','rejected') DEFAULT 'pending',
  submitted_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  admin_note          TEXT,
  UNIQUE KEY uniq_student_event (student_id, event_id),
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id)   REFERENCES events(id)            ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Sample event, matching the demo event seeded in script.js
-- ------------------------------------------------------------
INSERT INTO events (id, name, event_date, open_time, on_time_deadline, late_deadline, fine_amount, late_fine_amount, checkout_enabled)
VALUES ('ev1', 'Tech Conference', '2026-05-24', '07:00:00', '08:00:00', '09:00:00', 100.00, 0.00, 0);

<?php
/**
 * Attendance & Event Management System — REST-style API
 *
 * Usage:
 *   api.php?entity=students&action=list
 *   api.php?entity=students&action=create   (POST, JSON body)
 *   api.php?entity=students&action=update   (POST, JSON body, must include id)
 *   api.php?entity=students&action=delete   (POST, JSON body {id: ...})
 *
 * Supported entities: students, events, records, checkouts, photos, fines, appeals, admin
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

require __DIR__ . '/config.php';

$entity = $_GET['entity'] ?? '';
$action = $_GET['action'] ?? 'list';
$input  = json_decode(file_get_contents('php://input'), true) ?? [];

function respond($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function genId($prefix) {
    return $prefix . '_' . round(microtime(true) * 1000);
}

switch ($entity) {

    // ---------------------------------------------------------
    case 'students':
        if ($action === 'list') {
            $stmt = $pdo->query('SELECT * FROM students ORDER BY created_at DESC');
            respond($stmt->fetchAll());
        }
        if ($action === 'create') {
            $id = genId('stu');
            $stmt = $pdo->prepare('INSERT INTO students (id, student_id, name, department, email, contact, year_level, course) VALUES (?,?,?,?,?,?,?,?)');
            $stmt->execute([$id, $input['studentId'], $input['name'], $input['department'] ?? '', $input['email'] ?? '', $input['contact'] ?? '', $input['yearLevel'] ?? '', $input['course'] ?? '']);
            respond(['success' => true, 'id' => $id]);
        }
        if ($action === 'update') {
            $stmt = $pdo->prepare('UPDATE students SET name=?, department=?, email=?, contact=?, year_level=?, course=? WHERE student_id=?');
            $stmt->execute([$input['name'], $input['department'] ?? '', $input['email'] ?? '', $input['contact'] ?? '', $input['yearLevel'] ?? '', $input['course'] ?? '', $input['studentId']]);
            respond(['success' => true]);
        }
        if ($action === 'delete') {
            $stmt = $pdo->prepare('DELETE FROM students WHERE student_id=?');
            $stmt->execute([$input['studentId']]);
            respond(['success' => true]);
        }
        break;

    // ---------------------------------------------------------
    case 'events':
        if ($action === 'list') {
            $stmt = $pdo->query('SELECT * FROM events ORDER BY event_date');
            respond($stmt->fetchAll());
        }
        if ($action === 'create') {
            $id = genId('ev');
            $stmt = $pdo->prepare('INSERT INTO events (id, name, event_date, open_time, on_time_deadline, late_deadline, fine_amount, late_fine_amount, checkout_enabled, checkout_open, checkout_close) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
            $stmt->execute([$id, $input['name'], $input['date'], $input['openTime'], $input['onTimeDeadline'], $input['lateDeadline'], $input['fineAmount'] ?? 0, $input['lateFineAmount'] ?? 0, !empty($input['checkoutEnabled']) ? 1 : 0, $input['checkoutOpen'] ?? null, $input['checkoutClose'] ?? null]);
            respond(['success' => true, 'id' => $id]);
        }
        if ($action === 'update') {
            $stmt = $pdo->prepare('UPDATE events SET name=?, event_date=?, open_time=?, on_time_deadline=?, late_deadline=?, fine_amount=?, late_fine_amount=?, checkout_enabled=?, checkout_open=?, checkout_close=? WHERE id=?');
            $stmt->execute([$input['name'], $input['date'], $input['openTime'], $input['onTimeDeadline'], $input['lateDeadline'], $input['fineAmount'] ?? 0, $input['lateFineAmount'] ?? 0, !empty($input['checkoutEnabled']) ? 1 : 0, $input['checkoutOpen'] ?? null, $input['checkoutClose'] ?? null, $input['id']]);
            respond(['success' => true]);
        }
        if ($action === 'delete') {
            $stmt = $pdo->prepare('DELETE FROM events WHERE id=?');
            $stmt->execute([$input['id']]);
            respond(['success' => true]);
        }
        break;

    // ---------------------------------------------------------
    case 'records':
        if ($action === 'list') {
            $stmt = $pdo->query('SELECT * FROM attendance_records ORDER BY created_at DESC');
            respond($stmt->fetchAll());
        }
        if ($action === 'create') {
            $stmt = $pdo->prepare('INSERT INTO attendance_records (student_id, event_id, status, barcode_checkin, qr_checkin, appealed) VALUES (?,?,?,?,?,?)');
            $stmt->execute([$input['studentId'], $input['eventId'], $input['status'], !empty($input['barcodeCheckin']) ? 1 : 0, !empty($input['qrCheckin']) ? 1 : 0, !empty($input['appealed']) ? 1 : 0]);
            respond(['success' => true, 'id' => $pdo->lastInsertId()]);
        }
        break;

    // ---------------------------------------------------------
    case 'checkouts':
        if ($action === 'list') {
            $stmt = $pdo->query('SELECT * FROM checkouts');
            respond($stmt->fetchAll());
        }
        if ($action === 'create') {
            $stmt = $pdo->prepare('INSERT INTO checkouts (student_id, event_id, checkout_time, admin_checkout) VALUES (?,?,NOW(),?)
                ON DUPLICATE KEY UPDATE checkout_time = NOW(), admin_checkout = VALUES(admin_checkout)');
            $stmt->execute([$input['studentId'], $input['eventId'], !empty($input['adminCheckout']) ? 1 : 0]);
            respond(['success' => true]);
        }
        break;

    // ---------------------------------------------------------
    case 'photos':
        if ($action === 'get') {
            $stmt = $pdo->prepare('SELECT * FROM photos WHERE student_id=? AND event_id=? AND photo_type=?');
            $stmt->execute([$_GET['studentId'], $_GET['eventId'], $_GET['type'] ?? 'checkin']);
            respond($stmt->fetch() ?: null);
        }
        if ($action === 'create') {
            $stmt = $pdo->prepare('INSERT INTO photos (student_id, event_id, photo_type, photo_data) VALUES (?,?,?,?)
                ON DUPLICATE KEY UPDATE photo_data = VALUES(photo_data)');
            $stmt->execute([$input['studentId'], $input['eventId'], $input['type'] ?? 'checkin', $input['photoData']]);
            respond(['success' => true]);
        }
        break;

    // ---------------------------------------------------------
    case 'fines':
        if ($action === 'list') {
            $stmt = $pdo->query('SELECT * FROM fines ORDER BY created_at DESC');
            respond($stmt->fetchAll());
        }
        if ($action === 'create') {
            $stmt = $pdo->prepare('INSERT INTO fines (student_id, event_id, amount, fine_type, status) VALUES (?,?,?,?,?)
                ON DUPLICATE KEY UPDATE amount = VALUES(amount), status = VALUES(status)');
            $stmt->execute([$input['studentId'], $input['eventId'], $input['amount'], $input['type'], $input['status'] ?? 'unpaid']);
            respond(['success' => true]);
        }
        if ($action === 'update') {
            $stmt = $pdo->prepare('UPDATE fines SET status=? WHERE student_id=? AND event_id=? AND fine_type=?');
            $stmt->execute([$input['status'], $input['studentId'], $input['eventId'], $input['type']]);
            respond(['success' => true]);
        }
        if ($action === 'delete') {
            $stmt = $pdo->prepare('DELETE FROM fines WHERE student_id=? AND event_id=? AND fine_type=?');
            $stmt->execute([$input['studentId'], $input['eventId'], $input['type']]);
            respond(['success' => true]);
        }
        break;

    // ---------------------------------------------------------
    case 'appeals':
        if ($action === 'list') {
            $stmt = $pdo->query('SELECT * FROM appeals ORDER BY submitted_at DESC');
            respond($stmt->fetchAll());
        }
        if ($action === 'create') {
            $stmt = $pdo->prepare('INSERT INTO appeals (student_id, event_id, appeal_type, reason, evidence, evidence_file_name, status) VALUES (?,?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE appeal_type=VALUES(appeal_type), reason=VALUES(reason), evidence=VALUES(evidence), evidence_file_name=VALUES(evidence_file_name), status=VALUES(status)');
            $stmt->execute([$input['studentId'], $input['eventId'], $input['type'], $input['reason'], $input['evidence'] ?? null, $input['evidenceFileName'] ?? null, 'pending']);
            respond(['success' => true]);
        }
        if ($action === 'update') {
            $stmt = $pdo->prepare('UPDATE appeals SET status=?, admin_note=? WHERE student_id=? AND event_id=?');
            $stmt->execute([$input['status'], $input['adminNote'] ?? '', $input['studentId'], $input['eventId']]);
            respond(['success' => true]);
        }
        break;

    // ---------------------------------------------------------
    case 'admin':
        if ($action === 'login') {
            $stmt = $pdo->prepare('SELECT * FROM admin_credentials WHERE username=?');
            $stmt->execute([$input['username']]);
            $row = $stmt->fetch();
            if ($row && $row['pass_hash'] === $input['passHash']) {
                respond(['success' => true]);
            }
            respond(['success' => false, 'error' => 'Invalid credentials'], 401);
        }
        if ($action === 'changePassword') {
            $stmt = $pdo->prepare('UPDATE admin_credentials SET pass_hash=? WHERE username=?');
            $stmt->execute([$input['passHash'], $input['username']]);
            respond(['success' => true]);
        }
        // Used by the frontend's saveAdminCreds() to sync a username/password
        // change straight to the database (create the row if none exists yet).
        if ($action === 'updateCreds') {
            $existing = $pdo->query('SELECT id FROM admin_credentials LIMIT 1')->fetch();
            if ($existing) {
                $stmt = $pdo->prepare('UPDATE admin_credentials SET username=?, pass_hash=? WHERE id=?');
                $stmt->execute([$input['username'], $input['passHash'], $existing['id']]);
            } else {
                $stmt = $pdo->prepare('INSERT INTO admin_credentials (username, pass_hash) VALUES (?,?)');
                $stmt->execute([$input['username'], $input['passHash']]);
            }
            respond(['success' => true]);
        }
        break;

    // ---------------------------------------------------------
    // The frontend's data layer (script.js) doesn't use the granular
    // per-entity CRUD actions above for its normal operation. Instead it
    // keeps one in-memory mirror of the whole app state and, on every
    // mutation, calls sync/saveAll to push that whole state to MySQL; on
    // startup it calls sync/loadAll to pull it back. This also translates
    // between the DB's snake_case columns and the frontend's camelCase
    // field names, and between flat DB tables and the keyed-object shapes
    // (fines, appeals, checkouts, photos) the frontend expects.
    case 'sync':
        if ($action === 'loadAll') {
            $studentsOut = [];
            foreach ($pdo->query('SELECT * FROM students ORDER BY created_at')->fetchAll() as $r) {
                $studentsOut[] = [
                    'id' => $r['id'],
                    'studentId' => $r['student_id'],
                    'name' => $r['name'],
                    'department' => $r['department'],
                    'email' => $r['email'],
                    'contact' => $r['contact'],
                    'yearLevel' => $r['year_level'],
                    'course' => $r['course'],
                    'createdAt' => $r['created_at'],
                ];
            }

            $eventsOut = [];
            foreach ($pdo->query('SELECT * FROM events ORDER BY event_date')->fetchAll() as $r) {
                $eventsOut[] = [
                    'id' => $r['id'],
                    'name' => $r['name'],
                    'date' => $r['event_date'],
                    'openTime' => $r['open_time'],
                    'onTimeDeadline' => $r['on_time_deadline'],
                    'lateDeadline' => $r['late_deadline'],
                    'fineAmount' => (float)$r['fine_amount'],
                    'lateFineAmount' => (float)$r['late_fine_amount'],
                    'checkoutEnabled' => (bool)$r['checkout_enabled'],
                    'checkoutOpen' => $r['checkout_open'],
                    'checkoutClose' => $r['checkout_close'],
                ];
            }

            $recordsOut = [];
            foreach ($pdo->query('SELECT * FROM attendance_records ORDER BY created_at')->fetchAll() as $r) {
                $recordsOut[] = [
                    'studentId' => $r['student_id'],
                    'eventId' => $r['event_id'],
                    'status' => $r['status'],
                    'barcodeCheckin' => (bool)$r['barcode_checkin'],
                    'qrCheckin' => (bool)$r['qr_checkin'],
                    'appealed' => (bool)$r['appealed'],
                    'createdAt' => $r['created_at'],
                ];
            }

            $finesOut = new stdClass();
            foreach ($pdo->query('SELECT * FROM fines')->fetchAll() as $r) {
                $key = $r['student_id'] . '_' . $r['event_id'] . ($r['fine_type'] === 'late' ? '_late' : '');
                $finesOut->$key = [
                    'amount' => (float)$r['amount'],
                    'status' => $r['status'],
                    'type' => $r['fine_type'],
                    'studentId' => $r['student_id'],
                    'eventId' => $r['event_id'],
                    'createdAt' => $r['created_at'],
                ];
            }

            $appealsOut = new stdClass();
            foreach ($pdo->query('SELECT * FROM appeals')->fetchAll() as $r) {
                $key = $r['student_id'] . '_' . $r['event_id'];
                $appealsOut->$key = [
                    'studentId' => $r['student_id'],
                    'eventId' => $r['event_id'],
                    'type' => $r['appeal_type'],
                    'reason' => $r['reason'],
                    'evidence' => $r['evidence'],
                    'evidenceFileName' => $r['evidence_file_name'],
                    'status' => $r['status'],
                    'submittedAt' => $r['submitted_at'],
                    'adminNote' => $r['admin_note'],
                ];
            }

            $checkoutsOut = new stdClass();
            foreach ($pdo->query('SELECT * FROM checkouts')->fetchAll() as $r) {
                $key = $r['student_id'] . '_' . $r['event_id'];
                $checkoutsOut->$key = [
                    'time' => $r['checkout_time'],
                    'studentId' => $r['student_id'],
                    'eventId' => $r['event_id'],
                    'adminCheckout' => (bool)$r['admin_checkout'],
                ];
            }

            $photosOut = new stdClass();
            foreach ($pdo->query('SELECT * FROM photos')->fetchAll() as $r) {
                $key = ($r['photo_type'] === 'checkout' ? 'co_' : '') . $r['student_id'] . '_' . $r['event_id'];
                $photosOut->$key = $r['photo_data'];
            }

            $adminRow = $pdo->query('SELECT * FROM admin_credentials LIMIT 1')->fetch();
            $adminCredsOut = $adminRow
                ? ['username' => $adminRow['username'], 'passHash' => $adminRow['pass_hash']]
                : ['username' => 'admin', 'passHash' => null];

            respond([
                'students' => $studentsOut,
                'events' => $eventsOut,
                'records' => $recordsOut,
                'fines' => $finesOut,
                'appeals' => $appealsOut,
                'checkouts' => $checkoutsOut,
                'photos' => $photosOut,
                'adminCreds' => $adminCredsOut,
            ]);
        }

        if ($action === 'saveAll') {
            $pdo->beginTransaction();
            try {
                // ---- Students: upsert current ones, remove any dropped from the roster ----
                // (Photos cascade-delete with their student, so only rows that are
                // truly gone from the incoming state are deleted — everyone else is
                // upserted in place so their photos are never touched.)
                $students = $input['students'] ?? [];
                $studentIds = array_map(function ($s) { return $s['studentId']; }, $students);
                if ($studentIds) {
                    $placeholders = implode(',', array_fill(0, count($studentIds), '?'));
                    $pdo->prepare("DELETE FROM students WHERE student_id NOT IN ($placeholders)")->execute($studentIds);
                } else {
                    $pdo->exec('DELETE FROM students');
                }
                $stmt = $pdo->prepare('INSERT INTO students (id, student_id, name, department, email, contact, year_level, course)
                    VALUES (?,?,?,?,?,?,?,?)
                    ON DUPLICATE KEY UPDATE name=VALUES(name), department=VALUES(department), email=VALUES(email), contact=VALUES(contact), year_level=VALUES(year_level), course=VALUES(course)');
                foreach ($students as $s) {
                    $stmt->execute([
                        $s['id'] ?? genId('stu'), $s['studentId'], $s['name'], $s['department'] ?? '',
                        $s['email'] ?? '', $s['contact'] ?? '', $s['yearLevel'] ?? '', $s['course'] ?? '',
                    ]);
                }

                // ---- Events: same upsert-or-remove approach (photos reference events too) ----
                $events = $input['events'] ?? [];
                $eventIds = array_map(function ($e) { return $e['id']; }, $events);
                if ($eventIds) {
                    $placeholders = implode(',', array_fill(0, count($eventIds), '?'));
                    $pdo->prepare("DELETE FROM events WHERE id NOT IN ($placeholders)")->execute($eventIds);
                } else {
                    $pdo->exec('DELETE FROM events');
                }
                $stmt = $pdo->prepare('INSERT INTO events (id, name, event_date, open_time, on_time_deadline, late_deadline, fine_amount, late_fine_amount, checkout_enabled, checkout_open, checkout_close)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    ON DUPLICATE KEY UPDATE name=VALUES(name), event_date=VALUES(event_date), open_time=VALUES(open_time), on_time_deadline=VALUES(on_time_deadline), late_deadline=VALUES(late_deadline), fine_amount=VALUES(fine_amount), late_fine_amount=VALUES(late_fine_amount), checkout_enabled=VALUES(checkout_enabled), checkout_open=VALUES(checkout_open), checkout_close=VALUES(checkout_close)');
                foreach ($events as $e) {
                    $stmt->execute([
                        $e['id'], $e['name'], $e['date'], $e['openTime'] ?? null, $e['onTimeDeadline'] ?? null,
                        $e['lateDeadline'] ?? null, $e['fineAmount'] ?? 0, $e['lateFineAmount'] ?? 0,
                        !empty($e['checkoutEnabled']) ? 1 : 0, $e['checkoutOpen'] ?? null, $e['checkoutClose'] ?? null,
                    ]);
                }

                // ---- Records / fines / appeals / checkouts: no children depend on
                // these, so it's simplest & safest to replace them wholesale each save.
                $pdo->exec('DELETE FROM attendance_records');
                $stmt = $pdo->prepare('INSERT INTO attendance_records (student_id, event_id, status, barcode_checkin, qr_checkin, appealed) VALUES (?,?,?,?,?,?)');
                foreach (($input['records'] ?? []) as $r) {
                    $stmt->execute([
                        $r['studentId'], $r['eventId'], $r['status'],
                        !empty($r['barcodeCheckin']) ? 1 : 0, !empty($r['qrCheckin']) ? 1 : 0, !empty($r['appealed']) ? 1 : 0,
                    ]);
                }

                $pdo->exec('DELETE FROM fines');
                $stmt = $pdo->prepare('INSERT INTO fines (student_id, event_id, amount, fine_type, status) VALUES (?,?,?,?,?)');
                foreach (($input['fines'] ?? []) as $f) {
                    $stmt->execute([$f['studentId'], $f['eventId'], $f['amount'] ?? 0, $f['type'], $f['status'] ?? 'unpaid']);
                }

                $pdo->exec('DELETE FROM appeals');
                $stmt = $pdo->prepare('INSERT INTO appeals (student_id, event_id, appeal_type, reason, evidence, evidence_file_name, status) VALUES (?,?,?,?,?,?,?)');
                foreach (($input['appeals'] ?? []) as $a) {
                    $stmt->execute([
                        $a['studentId'], $a['eventId'], $a['type'], $a['reason'],
                        $a['evidence'] ?? null, $a['evidenceFileName'] ?? null, $a['status'] ?? 'pending',
                    ]);
                }

                $pdo->exec('DELETE FROM checkouts');
                $stmt = $pdo->prepare('INSERT INTO checkouts (student_id, event_id, checkout_time, admin_checkout) VALUES (?,?,NOW(),?)');
                foreach (($input['checkouts'] ?? []) as $c) {
                    $stmt->execute([$c['studentId'], $c['eventId'], !empty($c['adminCheckout']) ? 1 : 0]);
                }

                $pdo->commit();
                respond(['success' => true]);
            } catch (Exception $ex) {
                $pdo->rollBack();
                respond(['success' => false, 'error' => $ex->getMessage()], 500);
            }
        }
        break;

    default:
        respond(['error' => 'Unknown entity'], 404);
}

respond(['error' => 'Unknown action for entity ' . $entity], 400);
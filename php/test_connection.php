<?php
require __DIR__ . '/config.php';
echo "✅ Connected to the '$DB_NAME' database successfully!<br><br>";

$tables = $pdo->query("SHOW TABLES")->fetchAll(PDO::FETCH_COLUMN);
echo "Tables found:<br><ul>";
foreach ($tables as $t) {
    echo "<li>$t</li>";
}
echo "</ul>";

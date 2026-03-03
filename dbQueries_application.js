const db = require("../database");

// application.js

/**
 * Получить минимальный и максимальный возраст для заданного курса
 *
 * @param {number} courseId - ID курса
 * @returns {Promise<{course_age_min: number, course_age_max: number} | null>}
 *          Объект с возрастными границами или null, если курс не найден
 */
async function qr_getCourseAgeLimits(courseId) {
    const [rows] = await db.query(
        'SELECT course_age_min, course_age_max FROM course WHERE course_id = ?',
        [courseId]
    );

    return rows.length ? rows[0] : null;
}

/**
 * Добавляет нового родителя в базу данных
 *
 * @param {string} parentFio - ФИО родителя
 * @param {string} parentPhone - Телефон родителя
 * @param {string|null} parentMail - Email родителя (может быть null)
 * @returns {Promise<number>} - ID вставленного родителя (parent_id)
 */
async function qr_insertParent(parentFio, parentPhone, parentMail) {
    const [result] = await db.query(`
        INSERT INTO parent (parent_FIO, parent_phone, parent_mail)
        VALUES (?, ?, ?)
    `, [parentFio, parentPhone, parentMail || null]);

    return result.insertId;
}


/**
 * Добавляет нового ученика и заявку в базу данных.
 * Производит вставку в таблицы `student` и `application` в рамках одной транзакции.
 * В случае ошибки выполняется откат (rollback).
 *
 * @param {Object} applicationData - Данные анкеты.
 * @param {string} applicationData.student_fio - ФИО ученика.
 * @param {string} applicationData.student_birth - Дата рождения (в формате YYYY-MM-DD).
 * @param {string} applicationData.student_school - Название школы.
 * @param {string} applicationData.student_city_residence - Город проживания ученика.
 * @param {string} applicationData.student_city_school - Город, где находится школа.
 * @param {string} applicationData.student_snils - СНИЛС ученика.
 * @param {string} applicationData.student_navigator - Подана ли заявка в "Навигатор" ("да" или "нет").
 * @param {string} applicationData.student_comment - Комментарий к анкете.
 * @param {number} applicationData.student_class - Класс, в котором учится ученик.
 * @param {number} applicationData.group_id - ID выбранной учебной группы.
 * @param {number} parentId - ID родителя (связь с таблицей parent).
 *
 * @returns {Promise<number>} - ID созданной заявки (application_id).
 */
async function qr_insertStudent(applicationData, parentId) {
    const connection = await db.getConnection(); // получаем подключение напрямую
    try {
        await connection.beginTransaction();

        // Вставка в таблицу student
        const [studentResult] = await connection.query(`
            INSERT INTO student (student_FIO,
                                 student_snils,
                                 student_birth,
                                 student_class,
                                 student_city_residence,
                                 student_city_school,
                                 student_school,
                                 student_comment,
                                 parent_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            applicationData.student_fio,
            applicationData.student_snils,
            applicationData.student_birth,
            applicationData.student_class,
            applicationData.student_city_residence,
            applicationData.student_city_school,
            applicationData.student_school,
            applicationData.student_comment,
            parentId
        ]);

        const studentId = studentResult.insertId;
        const application_navigator = applicationData.student_navigator;
        const isNavigator = applicationData.student_navigator.toLowerCase() === 'да';


        // Вставка в таблицу application с новым полем application_navigator
        const [appResult] = await connection.query(`
            INSERT INTO application (application_status,
                                     student_id,
                                     group_id,
                                     application_navigator)
            VALUES ('active', ?, ?, ?)
        `, [
            studentId,
            applicationData.group_id,
            isNavigator || false // по умолчанию false
        ]);

        const applicationId = appResult.insertId;

        await connection.commit(); // всё успешно — фиксируем изменения
        return applicationId;

    } catch (error) {
        await connection.rollback(); // ошибка — откатываем
        throw error;
    } finally {
        connection.release(); // освобождаем соединение обратно в пул
    }
}


/**
 * Добавляет запись о подаче заявки в журнал заявок (application_log_tg)
 *
 * @param {number} studentId - ID ученика
 * @param {number} groupId - ID группы
 * @param {bigint} userTgId - Telegram ID пользователя (родителя)
 * @param {number} parentId - ID родителя
 * @returns {Promise<void>}
 */
async function qr_logApplicationSubmission(studentId, groupId, parentId, userTgId) {
    await db.query(`
        INSERT INTO application_log_tg (student_id,
                                        group_id,
                                        application_log_action_type,
                                        application_log_action_date,
                                        application_log_is_processed,
                                        application_log_notification_sent,
                                        application_log_change_details,
                                        parent_id,
                                        user_tg_id)
        VALUES (?, ?, 'active', NOW(), FALSE, FALSE, NULL, ?, ?)
    `, [
        studentId,
        groupId,
        parentId,
        userTgId
    ]);
}


/**
 * Получает информацию об ученике по ФИО и СНИЛС, включая все активные группы
 *
 * @param {string} fio - ФИО ученика
 * @param {string} snils - СНИЛС ученика
 * @returns {Promise<Object|null>} - Объект с данными ученика и его группами или null
 */
async function qr_getStudentInfoByFioAndSnils(fio, snils) {
    const [rows] = await db.query(`
        SELECT s.student_id,
               s.student_FIO,
               s.student_birth,
               g.group_name,
               s.parent_id
        FROM student s
                 LEFT JOIN application a ON s.student_id = a.student_id
                 LEFT JOIN learning_group g ON a.group_id = g.group_id
        WHERE s.student_FIO = ?
          AND s.student_snils = ?
    `, [fio, snils]);

    if (rows.length === 0) return null;

    return {
        student_id: rows[0].student_id,
        student_FIO: rows[0].student_FIO,
        student_birth: rows[0].student_birth,
        parent_id: rows[0].parent_id,
        groups: rows.map(r => r.group_name).filter(Boolean),
        fio: rows[0].student_FIO
    };
}


/**
 * Получает подробную информацию об ученике, его группе, курсе и расписании по ФИО и СНИЛС
 *
 * @param {string} fio - ФИО ученика
 * @param {string} snils - СНИЛС ученика
 * @returns {Promise<Array>} - Массив найденных записей (могут быть и неактивные заявки)
 */
async function qr_getStudentFullInfoByFioAndSnils(fio, snils) {
    const [records] = await db.query(`
        SELECT s.student_FIO,
               g.group_name,
               c.course_name,
               t.teacher_name,
               a.application_status,
               GROUP_CONCAT(DISTINCT CONCAT(
        wd.weekday_name, ' ', 
        TIME_FORMAT(lt.lesson_time_beg, '%H:%i'), '-', 
        TIME_FORMAT(lt.lesson_time_end, '%H:%i'), ' ауд. ', 
        cb.cabinet_name
      ) SEPARATOR '\\n') AS schedule
        FROM student s
                 JOIN application a ON s.student_id = a.student_id
                 JOIN learning_group g ON a.group_id = g.group_id
                 JOIN course c ON g.course_id = c.course_id
                 LEFT JOIN schedule sch ON g.group_id = sch.group_id
                 LEFT JOIN teacher t ON sch.teacher_id = t.teacher_id
                 LEFT JOIN weekday wd ON sch.weekday_id = wd.weekday_id
                 LEFT JOIN lesson_time lt ON sch.lesson_time_id = lt.lesson_time_id
                 LEFT JOIN cabinet cb ON sch.cabinet_id = cb.cabinet_id
        WHERE s.student_FIO = ?
          AND s.student_snils = ?
        GROUP BY s.student_id, a.application_status
    `, [fio, snils]);
    return records;
}

/**
 * Получает информацию о родителе по его идентификатору.
 *
 * @param {number} parentId - Идентификатор родителя
 * @returns {Promise<{ fio: string, phone: string, email: string } | null>} - Объект с данными родителя или null, если не найден
 */
async function qr_getParentInfoById(parentId) {
    const [rows] = await db.query(
        `
            SELECT parent_FIO   AS fio,
                   parent_phone AS phone,
                   parent_mail  AS email
            FROM parent
            WHERE parent_id = ? LIMIT 1
        `,
        [parentId]
    );

    return rows.length ? rows[0] : null;
}

/**
 * Получает ID родителя по ФИО и телефону.
 *
 * @param {string} fio - ФИО родителя
 * @param {string} phone - Телефон родителя
 * @returns {Promise<number|null>} - ID родителя, если найден, иначе null
 */
async function qr_getParentIdByFioAndPhone(fio, phone) {
    const [rows] = await db.query(
        `
            SELECT parent_id
            FROM parent
            WHERE parent_FIO = ?
              AND parent_phone = ? LIMIT 1
        `,
        [fio.trim(), phone.trim()]
    );

    return rows.length ? rows[0].parent_id : null;
}

module.exports = {
    qr_getCourseAgeLimits,
    qr_getStudentFullInfoByFioAndSnils,
    qr_insertParent,
    qr_insertStudent,
    qr_logApplicationSubmission,
    qr_getStudentInfoByFioAndSnils,
    qr_getParentInfoById,
    qr_getParentIdByFioAndPhone
};

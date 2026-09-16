const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve os arquivos do frontend diretamente da pasta public
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const AVA_URL = 'https://ava.ifes.edu.br';

// Estado global sincronizado em tempo real
const state = {
  teams: [],
  messages: [],
  onlineUsers: new Map()
};

io.on('connection', (socket) => {
  // Registro do usuário conectado
  socket.on('register_user', (userData) => {
    state.onlineUsers.set(socket.id, { socketId: socket.id, username: userData.username });
    io.emit('online_users_list', Array.from(state.onlineUsers.values()));
    socket.emit('sync_initial_state', { teams: state.teams, messages: state.messages });
  });

  // --- SINALIZAÇÃO WEBRTC (CHAMADAS E TRANSMISSÃO DE TELA) ---
  socket.on('call_user', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('incoming_call', { fromSocketId: socket.id, offer });
  });

  socket.on('answer_call', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('call_accepted', { fromSocketId: socket.id, answer });
  });

  socket.on('ice_candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('ice_candidate', { fromSocketId: socket.id, candidate });
  });

  // --- CHAT GLOBAL SINCRONIZADO ---
  socket.on('send_chat_message', (msg) => {
    state.messages.push(msg);
    io.emit('new_chat_message', msg);
  });

  // --- EQUIPES E BAÚ COM TRAVA DE 48H ---
  socket.on('create_team', (teamData) => {
    const newTeam = {
      id: Date.now().toString(),
      name: teamData.name,
      xp: 0,
      requiredXp: 100000, // XP alto necessário
      lastRewardUnlocked: 0,
      members: [teamData.creator]
    };
    state.teams.push(newTeam);
    io.emit('teams_updated', state.teams);
  });

  socket.on('donate_team_xp', ({ teamId, xpAmount }) => {
    const team = state.teams.find(t => t.id === teamId);
    if (team) {
      team.xp += Number(xpAmount);
      io.emit('teams_updated', state.teams);
    }
  });

  socket.on('claim_team_reward', ({ teamId }) => {
    const team = state.teams.find(t => t.id === teamId);
    if (!team) return;

    const NOW = Date.now();
    const COOLDOWN_48H = 48 * 60 * 60 * 1000;

    if (team.xp >= team.requiredXp && (NOW - team.lastRewardUnlocked >= COOLDOWN_48H)) {
      team.xp -= team.requiredXp;
      team.lastRewardUnlocked = NOW;
      io.emit('teams_updated', state.teams);
      socket.emit('reward_status', { success: true, message: 'Prêmio resgatado com sucesso!' });
    } else {
      socket.emit('reward_status', { 
        success: false, 
        message: 'Requisitos insuficientes de XP ou baú em tempo de recarga (48 horas).' 
      });
    }
  });

  socket.on('disconnect', () => {
    state.onlineUsers.delete(socket.id);
    io.emit('online_users_list', Array.from(state.onlineUsers.values()));
  });
});

// --- INTEGRACÃO MOODLE (AVA IFES) ---
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const response = await axios.get(`${AVA_URL}/login/token.php`, {
      params: { username, password, service: 'moodle_mobile_app' }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Erro de conexão com o AVA IFES.' });
  }
});

app.get('/api/courses', async (req, res) => {
  try {
    const { token, userid } = req.query;
    const response = await axios.get(`${AVA_URL}/webservice/rest/server.php`, {
      params: { wstoken: token, wsfunction: 'core_enrol_get_users_courses', moodlewsrestformat: 'json', userid }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar matérias.' });
  }
});

app.get('/api/course-contents', async (req, res) => {
  try {
    const { token, courseid } = req.query;
    const response = await axios.get(`${AVA_URL}/webservice/rest/server.php`, {
      params: { wstoken: token, wsfunction: 'core_course_get_contents', moodlewsrestformat: 'json', courseid }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter conteúdo do curso.' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));

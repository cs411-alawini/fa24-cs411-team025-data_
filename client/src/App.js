import React from 'react';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import Monuments from './Monuments'; // Assuming Monuments component already exists
import Dishes from './Dishes';

function App() {
    return (
        <Router>
            <Routes>
                <Route path="/monuments" element={<Monuments />} />
                <Route path="/dishes" element={<Dishes />} />
            </Routes>
        </Router>
    );
}

export default App;
